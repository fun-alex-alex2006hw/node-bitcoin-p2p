var assert = require('assert');
var sys = require('sys');
var logger = require('./logger');
var Util = require('./util');
var error = require('./error');

var MissingSourceError = error.MissingSourceError;

var TransactionStore = exports.TransactionStore = function (node) {
  events.EventEmitter.call(this);

  this.node = node;
  this.txIndex = {};
  this.txIndexByAcc = {};

  this.orphanTxIndex = {};
  this.orphanTxByPrev = {};
};

sys.inherits(TransactionStore, events.EventEmitter);

/**
 * Add transaction to memory pool.
 *
 * Note that transaction verification is asynchronous, so for proper error
 * handling you need to provide a callback.
 *
 * @return Boolean Whether the transaction was new.
 */
TransactionStore.prototype.add = function (tx, callback) {
  var txHash = tx.getHash().toString('base64');

  if (Array.isArray(this.txIndex[txHash])) {
    // Transaction is currently being verified, add callback to queue
    if ("function" == typeof callback) {
      this.txIndex[txHash].push(callback);
    }
    return false;
  } else if (this.txIndex[txHash]) {
    // Transaction is already known and verified, call callback immediately
    if ("function" == typeof callback) {
      callback(null, tx);
    }
    return false;
  }

  // Write down when we first noticed this transaction
  tx.first_seen = new Date();

  // TODO: Support orphan memory transactions (if an input is missing, keep
  //       the transaction in a separate pool in case the input is fulfilled
  //       later on.

  try {
    if (tx.isCoinBase()) {
      throw new Error("Coinbase transactions are only allowed as part of a block");
    }
    if (!tx.isStandard()) {
      throw new Error("Non-standard transactions are currently not accepted");
    }
    tx.verify(this, (function (err) {
      var callbackQueue = this.txIndex[txHash];

      if (!Array.isArray(callbackQueue)) {
        // This should never happen and if it does indicates an error in
        // this library.
        logger.error("Transaction store verification callback misfired");
        return;
      }
      if (err) {
        if (err instanceof MissingSourceError) {
          // Verification couldn't proceed because of a missing source
          // transaction. We'll add this one to the orphans and try
          // again later.
          this.orphanTxIndex[txHash] = tx;

          // Note that we'll call the callback now instead of waiting for
          // the missing source transaction, because we might never get it.
          // If the caller needs to handle this case, they should check for
          // a MissingSourceError themselves.
          if (!this.orphanTxByPrev[err.missingTxHash]) {
            this.orphanTxByPrev[err.missingTxHash] = [tx];
          } else {
            this.orphanTxByPrev[err.missingTxHash].push(tx);
          }
        } else {
          delete this.txIndex[txHash];
        }

        callbackQueue.forEach(function (cb) { cb(err, tx); });
        return;
      }

      // TODO: Check conflicts with other in-memory transactions

      this.txIndex[txHash] = tx;
      callbackQueue.forEach(function (cb) { cb(null, tx); });

      // Process any orphan transactions that are waiting for this one
      if (this.orphanTxByPrev[txHash]) {
        this.orphanTxByPrev[txHash].forEach(this.add.bind(this));
        delete this.orphanTxByPrev[txHash];
      }

      var eventData = {
        store: this,
        tx: tx
      };

      this.emit("txNotify", eventData);

      // Create separate events for each address affected by this tx
      if (this.node.cfg.feature.liveAccounting) {
        var affectedAccounts = tx.getAffectedAccounts();

        for (var i in affectedAccounts) {
          if(affectedAccounts.hasOwnProperty(i)) {
            if (!this.txIndexByAcc[i]) {
              this.txIndexByAcc[i] = [];
            }
            this.txIndexByAcc[i].push(txHash);
            this.emit('txNotify:'+i, eventData);
          }
        }
      }
    }).bind(this));

    this.txIndex[txHash] = [callback];
  } catch (e) {
    callback(e);
    return true;
  }

  return true;
};

TransactionStore.prototype.get = function (hash, callback) {
  if (hash instanceof Buffer) {
    hash = hash.toString('base64');
  }

  assert.equal(typeof hash, 'string');

  // If the transaction is currently being verified, we'll return null.
  if (Array.isArray(this.txIndex[hash])) {
    // But if there is a callback we'll return the transaction as soon as
    // it's ready.
    if ("function" == typeof callback) {
      this.txIndex[hash].push(callback);
    }
    return null;
  } else {
    // Note that we will return undefined if the transaction is not known
    if ("function" == typeof callback) {
      callback(null, this.txIndex[hash]);
    }
    return this.txIndex[hash];
  }
};

TransactionStore.prototype.remove = function (hash) {
  var self = this;
  if (hash instanceof Buffer) {
    hash = hash.toString('base64');
  }

  assert.equal(typeof hash, 'string');

  // If the transaction is currently being verified, we'll wait and
    // delete it later.
  if (Array.isArray(this.txIndex[hash])) {
    this.txIndex[hash].push(function (err, tx) {
      if (err) {
        // The transaction didn't make it anyway, we're done
        return;
      }

      self.remove(hash);
    });
  } else if (this.txIndex[hash]) {
    var tx = this.txIndex[hash];
    delete this.txIndex[hash];
    var eventData = {
      store: this,
      tx: tx,
      txHash: hash
    };
    this.emit('txCancel', eventData);

    // Create separate events for each address affected by this tx
    if (this.node.cfg.feature.liveAccounting) {
      var affectedAccounts = tx.getAffectedAccounts();

      for (var i in affectedAccounts) {
        if (affectedAccounts.hasOwnProperty(i)) {
          this.emit('txCancel:'+i, eventData);
        }
      }
    }
  }
};


TransactionStore.prototype.isKnown = function (hash) {
  if (hash instanceof Buffer) {
    hash = hash.toString('base64');
  }

  assert.equal(typeof hash, 'string');

  // Note that a transaction will return true here even is it is still
  // being verified.
  return !!this.txIndex[hash];
};


TransactionStore.prototype.find = function (hashes, callback) {
  var self = this;
  var callbacks = hashes.length;
  var disable = false;

  if (!hashes.length) {
    callback(null, []);
  }

  var result = [];
  hashes.forEach(function (hash) {
    self.get(hash, function (err, tx) {
      if (disable) {
        return;
      }

      if (err) {
        callback(err);
        disable = true;
      }

      callbacks--;

      if (tx) {
        result.push(tx);
      }

      if (callbacks === 0) {
        callback(null, result);
      }
    });
  });
};

TransactionStore.prototype.getByAccount = function (pubKeyHash) {
  if (pubKeyHash instanceof Buffer) {
    pubkeyHash = pubKeyHash.toString('base64');
  }

  var accIndex = this.txIndexByAcc[pubKeyHash], newIndex = [], txList = [];

  if (!accIndex) {
    return [];
  } else {
    for (var i = 0, l = accIndex.length; i < l; i++) {
      var tx = this.txIndex[accIndex[i]];
      if (tx) {
        // We use this opportunity to create a new index where the
        // tx that no longer exist in the pool are removed
        // TODO: This cleanup should probably be done on blockAdd
        newIndex.push(accIndex[i]);

        // TODO: Create the asynchronous version of this function
        if ("function" !== typeof tx) {
          txList.push(tx);
        }
      }
    }

    if (newIndex.length) {
      this.txIndexByAcc[pubKeyHash] = newIndex;
    } else {
      delete this.txIndexByAcc[pubKeyHash];
    }

    return txList;
  }
};

TransactionStore.prototype.findByAccount = function (pubKeyHashes, callback) {
  var self = this;

  var txList = [];
  pubKeyHashes.forEach(function (hash) {
    if (self.txIndexByAcc[hash]) {
      txList = txList.concat(self.txIndexByAcc[hash]);
    }
  });

  return this.find(txList, callback);
};

/**
 * Handles a spend entering the block chain.
 *
 * If a transaction spend enters the block chain, we have to remove it
 * and any conflicting transactions from the memory pool.
 */
TransactionStore.prototype.handleTxAdd = function (e) {
  // Remove transaction from memory pool
  var txHash = e.tx.hash.toString('base64');
  this.remove(txHash);

  // Notify other components about spent inputs
  if (!e.tx.isCoinBase()) {
    for (var i = 0, l = e.tx.ins.length; i < l; i++) {
      // TODO: Implement removal of conflicting tx
      // 1. Find transaction depending on this output
      // If there is none, we're done, otherwise:
      // 2. Remove it from the pool
      // 3. Issue txCancel messages
    }
  }
};
