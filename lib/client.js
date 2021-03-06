var net = require('net')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , protocol = require('./protocol')
  , dns = require('dns')
  , createPacketBuffer = protocol.createPacketBuffer
  , parsePacket = protocol.parsePacket
  , states = protocol.states
  , debug = protocol.debug
;

module.exports = Client;

function Client(isServer) {
  EventEmitter.call(this);

  this._state = states.HANDSHAKING;
  Object.defineProperty(this, "state", {
    get: function() {
      return this._state;
    },
    set: function(newProperty) {
      var oldProperty = this._state;
      this._state = newProperty;
      this.emit('state', newProperty, oldProperty);
    }
  });
  this.isServer = !!isServer;
  this.socket = null;
  this.encryptionEnabled = false;
  this.cipher = null;
  this.decipher = null;
  this.packetsToParse = {};
  this.on('newListener', function(event, listener) {
    var direction = this.isServer ? 'toServer' : 'toClient';
    if (protocol.packetStates[direction].hasOwnProperty(event) || event === "packet") {
      if (typeof this.packetsToParse[event] === "undefined") this.packetsToParse[event] = 1;
      else this.packetsToParse[event] += 1;
    }
  });
  this.on('removeListener', function(event, listener) {
    var direction = this.isServer ? 'toServer' : 'toClient';
    if (protocol.packetStates[direction].hasOwnProperty(event) || event === "packet") {
      this.packetsToParse[event] -= 1;
    }
  });
}

util.inherits(Client, EventEmitter);

// Transform weird "packet" types into string representing their type. Should be mostly retro-compatible
Client.prototype.on = function(type, func) {
    var direction = this.isServer ? 'toServer' : 'toClient';
    if (Array.isArray(type)) {
        arguments[0] = protocol.packetNames[type[0]][direction][type[1]];
    } else if (typeof type === "number") {
        arguments[0] = protocol.packetNames[this.state][direction][type];
    }
    EventEmitter.prototype.on.apply(this, arguments);
};

Client.prototype.onRaw = function(type, func) {
    var arg = "raw.";
    if (Array.isArray(type)) {
        arg += protocol.packetNames[type[0]][direction][type[1]];
    } else if (typeof type === "number") {
        arg += protocol.packetNames[this.state][direction][type];
    } else {
        arg += type;
    }
    arguments[0] = arg;
    EventEmitter.prototype.on.apply(this, arguments);
};

Client.prototype.setSocket = function(socket) {
  var self = this;
  self.socket = socket;
  if (self.socket.setNoDelay)
    self.socket.setNoDelay(true);
  var incomingBuffer = new Buffer(0);
  self.socket.on('data', function(data) {
    if (self.encryptionEnabled) data = new Buffer(self.decipher.update(data), 'binary');
    incomingBuffer = Buffer.concat([incomingBuffer, data]);
    var parsed, packet;
    while (true) {
      parsed = parsePacket(incomingBuffer, self.state, self.isServer, self.packetsToParse);
      if (! parsed) break;
      if (parsed.error) {
          this.emit('error', parsed.error);
          this.end("ProtocolError");
          return;
      }
      packet = parsed.results;
      incomingBuffer = incomingBuffer.slice(parsed.size);

      var packetName = protocol.packetNames[self.state][self.isServer ? 'toServer' : 'toClient'][packet.id];
      self.emit(packetName, packet);
      self.emit('packet', packet);
      self.emit('raw.' + packetName, parsed.buffer);
      self.emit('raw', parsed.buffer);
    }
  });

  self.socket.on('connect', function() {
    self.emit('connect');
  });

  self.socket.on('error', onError);
  self.socket.on('close', endSocket);
  self.socket.on('end', endSocket);
  self.socket.on('timeout', endSocket);

  function onError(err) {
    self.emit('error', err);
    endSocket();
  }

  var ended = false;
  function endSocket() {
    if (ended) return;
    ended = true;
    self.socket.removeListener('close', endSocket);
    self.socket.removeListener('end', endSocket);
    self.socket.removeListener('timeout', endSocket);
    self.emit('end', self._endReason);
  }
};

Client.prototype.connect = function(port, host) {
  var self = this;
  if (port == 25565) {
      dns.resolveSrv("_minecraft._tcp." + host, function(err, addresses) {
      if (addresses && addresses.length > 0) {
        self.setSocket(net.connect(addresses[0].port, addresses[0].name));
      } else {
        self.setSocket(net.connect(port, host));
      }
    });
  } else {
    self.setSocket(net.connect(port, host));
  }
};

Client.prototype.end = function(reason) {
  this._endReason = reason;
  this.socket.end();
};

Client.prototype.write = function(packetId, params) {
  if (Array.isArray(packetId)) {
     if (packetId[0] !== this.state)
      return false;
    packetId = packetId[1];
  }

  var buffer = createPacketBuffer(packetId, this.state, params, this.isServer);
  debug("writing packetId " + packetId + " (0x" + packetId.toString(16) + ")");
  debug(params);
  var out = this.encryptionEnabled ? new Buffer(this.cipher.update(buffer), 'binary') : buffer;
  this.socket.write(out);
  return true;
};

Client.prototype.writeRaw = function(buffer, shouldEncrypt) {
    if (shouldEncrypt === null) {
        shouldEncrypt = true;
    }
    var out = (shouldEncrypt && this.encryptionEnabled) ? new Buffer(this.cipher.update(buffer), 'binary') : buffer;
    this.socket.write(out);
};
