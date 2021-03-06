# node-bitcoin-p2p

This is a client library for the Bitcoin P2P network, written for
Node.js, using MongoDB as its back end.

# Differences to official client

The official client contains the node, wallet, GUI and miner. This
library only contains the node, i.e. the P2P part of Bitcoin. Its
intended use is as a server component to give lighter clients
access to the data in the block chain (in real-time.)

# Installation

## Prerequisites

Make sure you have the latest build of [Node.js](http://nodejs.org/)
from [github](https://github.com/joyent/node) installed. This library
uses functionality introduced in Node.js 0.5.0.

You also need [npm](http://npmjs.org/) 1.0+.

MongoDB should be installed and running:

``` sh
sudo aptitude install mongodb
```

Please install a development version of the libgmp library. On
Debian-based systems:

``` sh
sudo aptitude install libgmp3-dev
```

## Option 1 - Installation via npm (recommended)

This will install the current release from npm.

``` sh
sudo npm install bitcoin-p2p
```

This will install node-bitcoin-p2p locally. To install it globally,
add the `-g` flag to the above command. For more information on npm
1.0 link, see [this
post](http://blog.nodejs.org/2011/04/06/npm-1-0-link/).

## Option 2 - Installation from git

This will install the latest version straight from the repository:

``` sh
# Download a copy of node-bitcoin-p2p from git
git clone git://github.com/bitcoinjs/node-bitcoin-p2p.git --recursive
cd node-bitcoin-p2p

# Compile native components
node-waf configure build

# Download dependencies and install
sudo npm link
```

If you run into problems, please take a look at the "Troubleshooting"
section below or go to the Issues tab to open a new ticket.

# Upgrading

When upgrading node-bitcoin-p2p it is a good idea to reset its
database:

``` sh
mongo bitcoin --eval "db.dropDatabase()"
```

This won't be necessary once node-bitcoin-p2p is more stable, but for
now new versions often break database compatibility and since it only
takes about ten minutes to regenerate it makes sense to just reset it.

# Usage

Several examples on how to start up the library are provided in the
`examples/` folder. To run an example simply call it with node:

``` sh
node examples/simple.js
```

*It's highly recommended that you run bitcoind in front of bitcoin-p2p at this
time (simply have bitcoind running before launching bitcoin-p2p). Forward-facing
bitcoin-p2p nodes have not been well tested and may contain bugs that compromise
its security.*

The most basic way to start node-bitcoin-p2p in your own code  goes
like this:

``` js
var Bitcoin = require('bitcoin-p2p');

node = new Bitcoin.Node();
node.start();
```

All the other examples presuppose you've already started a node using
this code.

Once the node is running it will automatically connect to the Bitcoin
network and begin downloading blocks. There are two major ways to get
information from the library: Events and Storage.

## Events

Get a reference to the BlockChain object to start listening to block
chain changes:

``` js
var chain = node.getBlockChain();
// Log each block as it's added to the block chain
chain.addListener('blockSave', function (e) {
    console.log(e.block);
});
```

BlockChain emits the following events:

**`blockAdd`** - Triggered right before a block is saved to storage

- `block` The Block object for the block in question
- `txs` The transactions attached to the block
- `chain` The BlockChain object

**`blockSave`** - Triggered right after a block is saved to storage

- `block` The Block object for the block in question
- `txs` The transactions attached to the block
- `chain` The BlockChain object

**`blockRevoke`** - Triggered as the main chain is rolled back due to
a split *(warning: block chain reorg is still buggy)*

- `block` The Block object for the block in question
- `txs` The transactions attached to the block
- `chain` The BlockChain object

**`txAdd`** - Triggered right before a transaction is saved to storage

- `block` Containing Block object
- `index` The index of the transaction in question
- `tx` The Transaction object
- `chain` The BlockChain object

**`txSave`** - Triggered right after a transaction is saved to storage

- `block` Containing Block object
- `index` The index of the transaction in question
- `tx` The Transaction object
- `chain` The BlockChain object

**`txRevoke`** - Triggered when a confirmed transaction is reverted as
the containing block is no longer in the main chain *(warning: block
chain reorg is still buggy)*

- `block` Containing Block object
- `index` The index of the transaction in question
- `tx` The Transaction object
- `chain` The BlockChain object

TransactionStore emits the following events:

**`txNotify`** - A transaction was added to the memory pool

- `tx` The Transaction object
- `store` The TransactionStore object

**`txCancel`** - A transaction was removed from the memory pool
  (because it was confirmed or because a conflicting transaction was
  confirmed)

- `tx` The Transaction object
- `txHash` The transaction's hash in base64
- `store` The TransactionStore object

If the setting `feature.liveAccounting` is enabled, you can also
listen to `txNotify:[pubKeyHash as base64]` and `txCancel:[pubKeyHash as
base64]` to get events for a specific address only.

## Storage

`node-bitcoin-p2p` uses the Mongoose ORM layer. You can find the
schemas for the database objects in the source code under lib/schema/.

All the models are instantiated by the `Storage` class, so all you
need to do is get a reference to that from the Bitcoin `Node` and
you're good to go:

``` js
var storage = node.getStorage();
storage.Transaction.findOne({hash: hash}, function (err, tx) {
    // In real code, you'd handle the error of course
    if (err) return;

    storage.Block.findOne({_id: tx.block}, function (err, block) {
        if (err) return;

        // Do something fancy here...
    });
});
```

There are also some convenience functions you can use:

``` js
var chain = node.getBlockChain();
chain.getBlockByHash(hash, function (err, block) {
    if (err) return;

    // Do something with the Block
    console.log(block);
});
```

## Logging

`node-bitcoin-p2p` logs using the winston library. Currently, it
defaults to logging anything on the `debug` log level and higher. Here
are the available log levels:

- `netdbg` - Networking events (sending/receiving messages)
- `bchdbg` - Block chain events (adding blocks)
- `debug` - Other verbose logging
- `info` - General information and status messages
- `warn` - Something rare happened (e.g. strange pubKeyScript)
- `error` - Something bad happened

If you run node-bitcoin-p2p from a compatible shell, you should get a
fairly nice series of log messages as it is booting up.

# Tests

To run the test, please install [Vows](http://vowsjs.org) and run the
following command:

``` sh
vows test/* --spec
```

# Status

The library is currently alpha quality. Here are some things it
currently lacks:

- Correct handling of block chain splits
- Verify difficulty transitions
- Accept incoming Bitcoin connections (optionally)
- Store hashes etc. as MongoDB BinData instead of base64

On top of that, it could use a lot more documentation, test
cases and general bug fixing across the board.

You can find more information on the Issues tab on Github.

# Troubleshooting

## Native module missing

If you see this error:

    Error: Cannot find module '../build-cc/default/native'

This happens when the native components of node-bitcoin-p2p are not
compiled yet.

Make sure you have `libgmp3-dev` installed, then go to the
node-bitcoin-p2p folder and run:

``` sh
node-waf configure build
```

# Credits

node-bitcoin-p2p - Node.js Bitcoin client<br>
Copyright (c) 2011 Stefan Thomas <justmoon@members.fsf.org>.

Native extensions are<br>
Copyright (c) 2011 Andrew Schaaf <andrew@andrewschaaf.com>

Parts of this software are based on [BitcoinJ](http://code.google.com/p/bitcoinj/)<br>
Copyright (c) 2011 Google Inc.
