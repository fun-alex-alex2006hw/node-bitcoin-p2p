var mongoose = require('../../vendor/mongoose/lib/mongoose/index'); // database
var Util = require('../util');
var Script = require('../script').Script;
var bigint = require('bigint');
var Binary = require('binary');

var Schema = mongoose.Schema,
    ObjectId = Schema.ObjectId;

var BlockRules = exports.BlockRules = {
  maxTimeOffset: 2 * 60 * 60,  // How far block timestamps can be into the future
  largestHash: bigint(2).pow(256)
};

var Block = new Schema({
  hash: { type: Buffer, unique: true },
  prev_hash: { type: Buffer, index: true },
  merkle_root: Buffer,
  timestamp: Number,
  bits: Number,
  nonce: Number,
  version: String,
  height: { type: Number, index: true, default: -1 },
  size: Number,
  active: Boolean, // Whether block is part of the best known chain
  chainWork: Buffer // Amount of work in the chain up to this block
});

Block.method('getHeader', function () {
  put = Binary.put();
  put.word32le(this.version);
  put.put(this.prev_hash);
  put.put(this.merkle_root);
  put.word32le(this.timestamp);
  put.word32le(this.bits);
  put.word32le(this.nonce);
  return put.buffer();
});

Block.method('calcHash', function () {
  var header = this.getHeader();

  return Util.twoSha256(header);
});

Block.method('checkHash', function () {
  if (!this.hash) return false;

  return this.calcHash().compare(this.hash) == 0;
});

Block.method('getHash', function () {
  if (!this.hash) this.hash = this.calcHash();

  return this.hash;
});

Block.method('checkProofOfWork', function () {
  var target = Util.decodeDiffBits(this.bits);

  // TODO: Create a compare method in node-buffertools that uses the correct
  //       endian so we don't have to reverse both buffers before comparing.
  this.hash.reverse();

  if (this.hash.compare(target) > 0)
    throw 'Difficulty target not met';

  // Return the hash to its normal order
  this.hash.reverse();

  return true;
});

/**
 * Returns the amount of work that went into this block.
 *
 * Work is defined as the average number of tries required to meet this
 * block's difficulty target. For example a target that is greater than 5%
 * of all possible hashes would mean that 20 "work" is required to meet it.
 */
Block.method('getWork', function () {
  var target = Util.decodeDiffBits(this.bits, true);
  return BlockRules.largestHash.div(target.add(1));
});

Block.method('checkTimestamp', function () {
  var currentTime = new Date().getTime() / 1000;
  if (this.timestamp > currentTime + BlockRules.maxTimeOffset)
    throw 'Timestamp too far into the future';

  return true;
});

Block.method('checkTransactions', function (txs) {
  if (!Array.isArray(txs) || txs.length <= 0) throw 'No transactions';
  if (!txs[0].isCoinBase()) throw 'First tx must be coinbase';
  for (var i = 1; i < txs.length; i++)
    if (txs[i].isCoinBase()) throw 'Tx index '+i+' must not be coinbase';

  return true;
});

/**
 * Build merkle tree.
 *
 * Ported from Java. Original code: BitcoinJ by Mike Hearn
 * Copyright (c) 2011 Google Inc.
 */
Block.method('calcMerkleRoot', function (txs) {
  // The merkle hash is based on a tree of hashes calculated from the transactions:
  //
  //          merkleHash
  //             /\
  //            /  \
  //          A      B
  //         / \    / \
  //       tx1 tx2 tx3 tx4
  //
  // Basically transactions are hashed, then the hashes of the transactions are hashed
  // again and so on upwards into the tree. The point of this scheme is to allow for
  // disk space savings later on.
  //
  // This function is a direct translation of CBlock::BuildMerkleTree().

  if (txs.length == 0) {
    return Util.NULL_HASH.slice(0);
  }

  // Start by adding all the hashes of the transactions as leaves of the tree.
  var tree = txs.map(function (tx) {
    return tx.getHash();
  });

  var j = 0;
  // Now step through each level ...
  for (var size = txs.length; size > 1; size = (size + 1) / 2) {
    // and for each leaf on that level ..
    for (var i = 0; i < size; i += 2) {
      var i2 = Math.min(i + 1, size - 1);
      var a = tree[j + i];
      var b = tree[j + i2];
      tree.add(Util.twoSha256(a.concat(b)));
    }
    j += size;
  }

  return tree[tree.length - 1];
});

Block.method('checkMerkleRoot', function (txs) {
  if (!this.merkle_root) {
    throw 'No merkle root';
  }

  if (this.calcMerkleRoot().compare(this.merkle_root) == 0) {
    throw 'Merkle root incorrect';
  }

  return true;
});

Block.method('checkBlock', function (txs) {
  this.checkProofOfWork();
  this.checkTimestamp();

  if (txs) {
    this.checkTransactions(txs);
    if (!this.checkMerkleRoot(txs)) throw "Merkle hash invalid";
  }
  return true;
});

Block.static('getBlockValue', function (height) {
  var subsidy = bigint(50).mul(Util.COIN);
  subsidy = subsidy.div(bigint(2).pow(Math.floor(height / 210000)));
  return subsidy;
});

Block.method('getBlockValue', function () {
  return this.schema.statics.getBlockValue(this.height);
});

Block.method('toString', function () {
  return "<Block " + Util.formatHash(this.hash) + " height="+this.height+">";
});

Block.method('setChainWork', function (chainWork) {
  if (chainWork instanceof bigint) {
    chainWork = chainWork.toBuffer();
  } else if (chainWork instanceof Buffer) {
    // Nothing to do
  }

  this.chainWork = chainWork;
});

Block.method('getChainWork', function () {
  return bigint.fromBuffer(this.chainWork);
});

/**
 * Compares the chainWork of two blocks.
 */
Block.method('moreWorkThan', function (otherBlock) {
  return this.getChainWork().cmp(otherBlock.getChainWork()) > 0;
});

Block.method('createCoinbaseTx', function (beneficiary) {
  var Transaction = this.db.model('Transaction');

  var tx = new Transaction();
  tx.ins.push({
    script: new Buffer(0),
    sequence: 0xffffffff,
    outpoint: {
      hash: Util.NULL_HASH,
      index: 0
    }
  });
  tx.outs.push({
    value: Util.bigIntToValue(this.getBlockValue()),
    script: Script.createPubKeyOut(beneficiary).getBuffer()
  });
  return tx;
});

Block.method('mineNextBlock', function (beneficiary, time, miner, callback) {
  try {
    var Block = this.db.model('Block');
    var Transaction = this.db.model('Transaction');

    var newBlock = new Block();

    // TODO: Use correct difficulty
    newBlock.bits = this.bits;
    newBlock.timestamp = time;
    newBlock.prev_hash = this.hash.slice(0);
    newBlock.height = this.height+1;

    // Create coinbase transaction
    var txs = [];

    var tx = newBlock.createCoinbaseTx(beneficiary);
    txs.push(tx);

    newBlock.merkle_root = newBlock.calcMerkleRoot(txs);

    newBlock.solve(miner, function (err, nonce) {
      newBlock.nonce = nonce;

      // Make sure hash is cached
      newBlock.getHash();

      callback(err, newBlock, txs);
    });

    // Return reference to (unfinished) block
    return newBlock;
  } catch (e) {
    callback(e);
  }
});

Block.method('solve', function (miner, callback) {
  var header = this.getHeader();
  var target = Util.decodeDiffBits(this.bits);
  miner.solve(header, target, callback);
});


mongoose.model('Block', Block);
