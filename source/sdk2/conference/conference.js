/* global io, console */

/**
 * @class Woogeen.ConferenceClient
 * @classDesc Provides connection, local stream publication, and remote stream　subscription for a video conference. The conference client is　created by the server side API. The conference client is retrieved　by the client API with the access token for the connection.
 */

Woogeen.ConferenceClient = (function () {
  'use strict';

  function safeCall () {
    var callback = arguments[0];
    if (typeof callback === 'function') {
      var args = Array.prototype.slice.call(arguments, 1);
      callback.apply(null, args);
    }
  }

  Woogeen.sessionId = 103;

  function createChannel (spec) {
    spec.session_id = (Woogeen.sessionId += 1);
    var that;
    if (window.navigator.userAgent.match('Firefox') !== null) {
      // Firefox
      that = Erizo.FirefoxStack(spec);
      that.browser = 'mozilla';
    } else if (window.navigator.appVersion.indexOf('Trident') > -1) {
      that = Erizo.IEStableStack(spec);
      that.browser = 'internet-explorer';
    } else if (window.navigator.appVersion.match(/Chrome\/([\w\W]*?)\./)[1] >= 26) {
      // Google Chrome Stable.
      that = Erizo.ChromeStableStack(spec);
      that.browser = 'chrome-stable';
    } else {
      // None.
      throw 'WebRTC stack not available';
    }
    return that;
  }

  var DISCONNECTED = 0, CONNECTING = 1, CONNECTED = 2;
  var internalDispatcher = Woogeen.EventDispatcher({});

  function WoogeenConference (spec) {
    var that = spec || {};
    this.remoteStreams = {};
    this.localStreams = {};
    that.state = DISCONNECTED;
//TODO: no param function, but there is a description in API doc.
//TODO: fill return type
/**
   * @function setIceServers
   * @desc This function establishes a connection to server and joins a certain conference.
<br><b>Remarks:</b><br>
This method accepts string, object, or array (multiple ones) type of ice server item as argument. Typical description of each valid value should be as below:<br>
<ul>
<li>For turn: {url: "url", username: "username", credential: "password"}.</li>
<li>For stun: {url: "url"}, or simply "url" string.</li>
</ul>
Each time this method is called, previous saved value would be discarded. Specifically, if parameter servers is not provided, the result would be an empty array, meaning any predefined servers are discarded.
   * @instance
   * @memberOf Woogeen.ConferenceClient
   * @param {TYPE} servers turn or stun server configuration.
   * @return {TYPE} Result of the user-set of ice servers.
   * @example
<script type="text/JavaScript”>
room.setIceServers([{
      url: "turn:61.152.239.56:4478?transport=udp",
      username: "woogeen",
      credential: "master"
    }, {
      url: "turn:61.152.239.56:443?transport=tcp",
      username: "woogeen",
      credential: "master"
    }]);
</script>
   */
    this.setIceServers = function () {
      that.userSetIceServers = [];
      Array.prototype.slice.call(arguments, 0).map(function (arg) {
        if (arg instanceof Array) {
          arg.map(function (server) {
            if (typeof server === 'object' && server !== null && typeof server.url === 'string' && server.url !== '') {
              that.userSetIceServers.push(server);
            } else if (typeof server === 'string' && server !== '') {
              that.userSetIceServers.push({url: server});
            }
          });
        } else if (typeof arg === 'object' && arg !== null && typeof arg.url === 'string' && arg.url !== '') {
          that.userSetIceServers.push(arg);
        } else if (typeof arg === 'string' && arg !== '') {
          that.userSetIceServers.push({url: arg});
        }
      });
      return that.userSetIceServers;
    };

    this.getIceServers = function () {
      return that.userSetIceServers;
    };

    Object.defineProperties(this, {
      state: {
        get: function () {
          return that.state;
        }
      }
    });

//TODO:fill return description
/**
   * @function join
   * @instance
   * @desc This function establishes a connection to server and joins a certain　conference.
<br><b>Remarks:</b><br>
On success, successCallback is called (if provided); otherwise, failureCallback is called (if provided).
   * @memberOf Woogeen.ConferenceClient
   * @param {string} token Token used to join conference room.
   * @param {function} onSuccess (optional) Success callback function.
   * @param {function} onFailure (optional) Failure callback function.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
conference.join(token, function(response) {...}, function(error) {...});
</script>
   */
    this.join = function (token, onSuccess, onFailure) {
      var self = this;
      try {
        token = JSON.parse(L.Base64.decodeBase64(token));
      } catch (err) {
        return safeCall(onFailure, 'invalid token');
      }

      var isSecured = (token.secure === true);
      var host = token.host;
      if (typeof host !== 'string') {
        return safeCall(onFailure, 'invalid host');
      }
      // check connection>host< state
      if (self.state !== DISCONNECTED) {
        return safeCall(onFailure, 'connection state invalid');
      }

      self.on('server-disconnected', function () { // onConnectionClose handler
        that.state = DISCONNECTED;
        self.myId = null;
        var i, stream;
        // remove all remote streams
        for (i in self.remoteStreams) {
          if (self.remoteStreams.hasOwnProperty(i)) {
            stream = self.remoteStreams[i];
            stream.close();
            delete self.remoteStreams[i];
            var evt = new Woogeen.StreamEvent({type: 'stream-removed', stream: stream});
            self.dispatchEvent(evt);
          }
        }

        // close all channel
        for (i in self.localStreams) {
          if (self.localStreams.hasOwnProperty(i)) {
            stream = self.localStreams[i];
            if (stream.channel && typeof stream.channel.close === 'function') {
              stream.channel.close();
            }
            delete self.localStreams[i];
          }
        }

        // close socket.io
        try {
          self.socket.disconnect();
        } catch (err) {}
      });

      that.state = CONNECTING;

      if (self.socket !== undefined) { // whether reconnect
        self.socket.connect();
      } else {
        var dispatchEventAfterSubscribed = function (event) {
          var remoteStream = event.stream;
          if (remoteStream.channel && typeof remoteStream.signalOnPlayAudio === 'function') {
            self.dispatchEvent(event);
          } else if (remoteStream.channel && remoteStream.channel.state !== 'closed') {
            setTimeout(function () {
              dispatchEventAfterSubscribed(event);
            }, 20);
          } else {
            L.Logger.warning('event missed:', event.type);
          }
        };

        self.socket = io.connect(host, {
          reconnect: false,
          secure: isSecured,
          'force new connection': true
        });

        self.socket.on('onAddStream', function (spec) {
          if (self.remoteStreams[spec.id] !== undefined) {
            L.Logger.warning('stream already added:', spec.id);
            return;
          }
          var stream = new Woogeen.RemoteStream({
            video: spec.video,
            audio: spec.audio,
            id: spec.id,
            from: spec.from,
            attributes: spec.attributes
          });
          var evt = new Woogeen.StreamEvent({type: 'stream-added', stream: stream});
          self.remoteStreams[spec.id] = stream;
          self.dispatchEvent(evt);
        });

        self.socket.on('onRemoveStream', function (spec) {
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            stream.close(); // >removeStream<
            delete self.remoteStreams[spec.id];
            var evt = new Woogeen.StreamEvent({type: 'stream-removed', stream: stream});
            self.dispatchEvent(evt);
          }
        });

        self.socket.on('onSubscribeP2P', function (spec) { // p2p conference call
          var myStream = self.localStreams[spec.streamId];
          if (myStream.channel === undefined) {
            myStream.channel = {};
          }

          myStream.channel[spec.subsSocket] = createChannel({
            callback: function (offer) {
              sendSdp(self.socket, 'publish', {
                state: 'p2pSignaling',
                streamId: spec.streamId,
                subsSocket: spec.subsSocket
              }, offer, function (answer) {
                if (answer === 'error' || answer === 'timeout') {
                  L.Logger.warning('invalid answer');
                  return;
                }
                myStream.channel[spec.subsSocket].onsignalingmessage = function () {
                  myStream.channel[spec.subsSocket].onsignalingmessage = function () {};
                };
                myStream.channel[spec.subsSocket].processSignalingMessage(answer);
              });
            },
            audio: myStream.hasAudio(),
            video: myStream.hasVideo(),
            stunServerUrl: self.connSettings.stun,
            turnServer: self.connSettings.turn
          });

          myStream.channel[spec.subsSocket].addStream(myStream.mediaStream);
          myStream.channel[spec.subsSocket].oniceconnectionstatechange = function (state) {
            if (state === 'disconnected') {
              myStream.channel[spec.subsSocket].close();
              delete myStream.channel[spec.subsSocket];
            }
          };
        });

        self.socket.on('onPublishP2P', function (spec, callback) {
          var myStream = self.remoteStreams[spec.streamId];

          myStream.channel = createChannel({
            callback: function () {},
            stunServerUrl: self.connSettings.stun,
            turnServer: self.connSettings.turn,
            maxAudioBW: self.connSettings.maxAudioBW,
            maxVideoBW: self.connSettings.maxVideoBW
          });

          myStream.channel.onsignalingmessage = function (answer) {
            myStream.channel.onsignalingmessage = function () {};
            safeCall(callback, answer);
          };

          myStream.channel.processSignalingMessage(spec.sdp);

          myStream.channel.onaddstream = function (evt) {
            myStream.mediaStream = evt.stream;
            internalDispatcher.dispatchEvent(new Woogeen.StreamEvent({type: 'p2p-stream-subscribed', stream: myStream}));
          };
        });

        // We receive an event of remote video stream paused
        self.socket.on('onVideoHold', function (spec) {
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            var evt = new Woogeen.StreamEvent({type: 'video-hold', stream: stream});
            dispatchEventAfterSubscribed(evt);
          }
        });

        // We receive an event of remote video stream resumed
        self.socket.on('onVideoReady', function (spec) {
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            var evt = new Woogeen.StreamEvent({type: 'video-ready', stream: stream});
            dispatchEventAfterSubscribed(evt);
          }
        });

        // We receive an event of remote audio stream paused
        self.socket.on('onAudioHold', function (spec) {
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            var evt = new Woogeen.StreamEvent({type: 'audio-hold', stream: stream});
            dispatchEventAfterSubscribed(evt);
          }
        });

        // We receive an event of remote audio stream resumed
        self.socket.on('onAudioReady', function (spec) {
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            var evt = new Woogeen.StreamEvent({type: 'audio-ready', stream: stream});
            dispatchEventAfterSubscribed(evt);
          }
        });

        // We receive an event of all the remote audio streams paused
        self.socket.on('onAllAudioHold', function () {
          for (var index in self.remoteStreams) {
            if (self.remoteStreams.hasOwnProperty(index)) {
              var stream = self.remoteStreams[index];
              var evt = new Woogeen.StreamEvent({type: 'audio-hold', stream: stream});
              dispatchEventAfterSubscribed(evt);
            }
          }
        });

        // We receive an event of all the remote audio streams resumed
        self.socket.on('onAllAudioReady', function () {
          for (var index in self.remoteStreams) {
            if (self.remoteStreams.hasOwnProperty(index)) {
              var stream = self.remoteStreams[index];
              var evt = new Woogeen.StreamEvent({type: 'audio-ready', stream: stream});
              dispatchEventAfterSubscribed(evt);
            }
          }
        });

        self.socket.on('onUpdateStream', function (spec) {
          // Handle: 'VideoEnabled', 'VideoDisabled', 'AudioEnabled', 'AudioDisabled', 'VideoLayoutChanged', [etc]
          var stream = self.remoteStreams[spec.id];
          if (stream) {
            stream.emit(spec.event, spec.data);
          }
        });

        self.socket.on('disconnect', function () {
          if (that.state !== DISCONNECTED) {
            var evt = new Woogeen.ClientEvent({type: 'server-disconnected'});
            self.dispatchEvent(evt);
          }
        });

        self.socket.on('onUserJoin', function (spec) {
          var evt = new Woogeen.ClientEvent({type: 'user-joined', user: spec.user});
          self.dispatchEvent(evt);
        });

        self.socket.on('onUserLeave', function (spec) {
          var evt = new Woogeen.ClientEvent({type: 'user-left', user: spec.user});
          self.dispatchEvent(evt);
        });

        self.socket.on('onCustomMessage', function (spec) {
          var evt = new Woogeen.MessageEvent({type: 'message-received', msg: spec});
          self.dispatchEvent(evt);
        });

        self.socket.on('connect_failed', function (err) {
          safeCall(onFailure, err || 'connection_failed');
        });

        self.socket.on('error', function (err) {
          safeCall(onFailure, err || 'connection_error');
        });
      }

      try {
        self.socket.emit('token', token, function (status, resp) {
          if (status === 'success') {
            self.connSettings = {
              turn: resp.turnServer,
              stun: resp.stunServerUrl,
              defaultVideoBW: resp.defaultVideoBW,
              maxVideoBW: resp.maxVideoBW
            };
            self.myId = resp.clientId;
            self.conferenceId = resp.id;
            self.p2p = resp.p2p;
            that.state = CONNECTED;
            var streams = resp.streams.map(function (st) {
              self.remoteStreams[st.id] = new Woogeen.RemoteStream(st);
              return self.remoteStreams[st.id];
            });
            return safeCall(onSuccess, {streams: streams, users: resp.users});
          }
          return safeCall(onFailure, resp||'response error');
        });
      } catch (e) {
        safeCall(onFailure, 'socket emit error');
      }
    };

  }

  function sendMsg(socket, type, message, callback) {
    if (!socket || !socket.connected) {
      return callback('socket not ready');
    }
    try {
      socket.emit(type, message, function (resp, mesg) {
        if (resp === 'success') {
          return callback(null, mesg);
        }
        return callback(mesg||'response error');
      });
    } catch (err) {
      callback('socket emit error');
    }
  }

  function sendSdp(socket, type, option, sdp, callback) {
    if (!socket || !socket.connected) {
      return callback('error', 'socket not ready');
    }
    try {
      socket.emit(type, option, sdp, function (status, resp) {
        callback(status, resp);
      });
    } catch (err) {
      callback('error', 'socket emit error');
    }
  }

  function sendCtrlPayload(socket, action, streamId, onSuccess, onFailure) {
    var payload = {
      type: 'control',
      payload: {
        action: action,
        streamId: streamId
      }
    };
    sendMsg(socket, 'customMessage', payload, function(err, resp) {
      if (err) {
        return safeCall(onFailure, err);
      }
      safeCall(onSuccess, resp);
    });
  }

  WoogeenConference.prototype = Woogeen.EventDispatcher({}); // make WoogeenConference a eventDispatcher
/**
   * @function leave
   * @instance
   * @desc This function leaves conference and disconnects from server. Once it is done, ‘server-disconnected’ event would be triggered.
   * @memberOf Woogeen.ConferenceClient
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ......
conference.leave();
</script>
   */
  WoogeenConference.prototype.leave = function () {
    var evt = new Woogeen.ClientEvent({type: 'server-disconnected'});
    this.dispatchEvent(evt);
  };
  //TODO: fill return description and type
/**
   * @function send
   * @instance
   * @desc This function send message to conference room. The receiver should be a valid clientId, which is carried by ‘user-joined’ event; or default 0, which means send to all participants in the conference (broadcast) except himself.
   * @memberOf Woogeen.ConferenceClient
   * @param {string/function} data Message/object to send.
   * @param {string/function} receiver Receiver, optional, with default value 0.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.send(message, receiver, function (obj) {
    L.Logger.info('object sent:', obj.id());
  }, function (err) {
    L.Logger.error('send failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.send = function (data, receiver, onSuccess, onFailure) {
    if (data === undefined || data === null || typeof data === 'function') {
      return safeCall(onFailure, 'nothing to send');
    }
    if (typeof receiver === 'undefined') {
      receiver = 'all';
    } else if (typeof receiver === 'string') {
      // supposed to be a valid receiverId.
      // pass.
    } else if (typeof receiver === 'function') {
      onFailure = onSuccess;
      onSuccess = receiver;
      receiver = 'all';
    } else {
      return safeCall(onFailure, 'invalid receiver');
    }
    sendMsg(this.socket, 'customMessage', {
      type: 'data',
      data: data,
      receiver: receiver
    }, function (err, resp) {
      if (err) {
        return safeCall(onFailure, err);
      }
      safeCall(onSuccess, resp);
    });
  };

  /*
  options: {
    audio: true/false,
    video: true/false,
    maxVideoBW: xxx,
    maxAudioBW: xxx,
    unmix: false/true, // if true, this stream would not be included in mix stream
    videoCodec: 'h264' // not for p2p room
  }
  */

//TODO: fill return description and type
/**
   * @function publish
   * @instance
   * @desc This function publishes the local stream to the server. The stream should be a valid LocalStream instance. ‘stream-added’ event would be triggered when the stream is published successfully
   * @memberOf Woogeen.ConferenceClient
   * @param {stream} stream Stream to publish.
   * @param {json} options Publish options.
   * @desc Options:<br>
{<br>
video: true/false,<br>
audio: true/false,<br>
maxVideoBW: xxx,<br>
videoCodec: ‘h264’/’vp8’ // not applicable for p2p room<br>
}
   * @param {function} onSuccess (optional) Success callback.
   * @param {function} onFailure (optional) Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.publish(localStream, {maxVideoBW: 300}, function (st) {
    L.Logger.info('stream published:', st.id());
  }, function (err) {
    L.Logger.error('publish failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.publish = function (stream, options, onSuccess, onFailure) {
    var self = this;
    stream = stream || {};
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = stream.bitRate;
    } else if (typeof options !== 'object' || options === null) {
      options = stream.bitRate;
    }
    if (!(stream instanceof Woogeen.LocalStream) ||
          ((typeof stream.mediaStream !== 'object' || stream.mediaStream === null) &&
             stream.url() === undefined)) {
      return safeCall(onFailure, 'invalid stream');
    }

    if (self.localStreams[stream.id()] === undefined) { // not pulished
      var opt = stream.toJson();
      if (options.unmix === true) {
        opt.unmix = true;
      }
      if (stream.url() !== undefined) {
        opt.state = 'url';
        sendSdp(self.socket, 'publish', opt, stream.url(), function (answer, id) {
            if (answer !== 'success') {
              return safeCall(onFailure, answer);
            }
            stream.id = function () {
              return id;
            };
            stream.unpublish = function (onSuccess, onFailure) {
              self.unpublish(stream, onSuccess, onFailure);
            };
            self.localStreams[id] = stream;
            safeCall(onSuccess, stream);
        });
        return;
      } else if (self.p2p) {
        self.connSettings.maxVideoBW = options.maxVideoBW;
        self.connSettings.maxAudioBW = options.maxAudioBW;
        opt.state = 'p2p';
        sendSdp(self.socket, 'publish', opt, null, function (answer, id) {
            if (answer === 'error') {
              return safeCall(onFailure, answer);
            }
            stream.id = function () {
              return id;
            };
            stream.unpublish = function (onSuccess, onFailure) {
              self.unpublish(stream, onSuccess, onFailure);
            };
            self.localStreams[id] = stream;
            safeCall(onSuccess, stream);
        });
        return;
      }
      options.maxVideoBW = options.maxVideoBW || self.connSettings.defaultVideoBW;
      if (options.maxVideoBW > self.connSettings.maxVideoBW) {
        options.maxVideoBW = self.connSettings.maxVideoBW;
      }
      stream.channel = createChannel({
        callback: function (offer) {
          opt.state = 'offer';
          sendSdp(self.socket, 'publish', opt, offer, function (answer, id) {
            if (answer === 'error') {
              return safeCall(onFailure, id);
            }
            if (answer === 'timeout') {
              return safeCall(onFailure, answer);
            }
            stream.channel.onsignalingmessage = function () {
              stream.channel.onsignalingmessage = function () {};
              stream.id = function () {
                return id;
              };
              self.localStreams[id] = stream;
              stream.signalOnPlayAudio = function (onSuccess, onFailure) {
                sendCtrlPayload(self.socket, 'audio-out-on', id, onSuccess, onFailure);
              };
              stream.signalOnPauseAudio = function (onSuccess, onFailure) {
                sendCtrlPayload(self.socket, 'audio-out-off', id, onSuccess, onFailure);
              };
              stream.signalOnPlayVideo = function (onSuccess, onFailure) {
                sendCtrlPayload(self.socket, 'video-out-on', id, onSuccess, onFailure);
              };
              stream.signalOnPauseVideo = function (onSuccess, onFailure) {
                sendCtrlPayload(self.socket, 'video-out-off', id, onSuccess, onFailure);
              };
              stream.unpublish = function (onSuccess, onFailure) {
                self.unpublish(stream, onSuccess, onFailure);
              };
              safeCall(onSuccess, stream);
            };

            stream.channel.oniceconnectionstatechange = function (state) {
              if (state === 'failed') {
                sendMsg(self.socket, 'unpublish', stream.id(), function () {}, function () {});
                stream.channel.close();
                stream.channel = undefined;
                delete self.localStreams[stream.id()];
                stream.id = function () { return null; };
                stream.signalOnPlayAudio = undefined;
                stream.signalOnPauseAudio = undefined;
                stream.signalOnPlayVideo = undefined;
                stream.signalOnPauseVideo = undefined;
                delete stream.unpublish;
                safeCall(onFailure, 'peer connection failed');
              }
            };
            stream.channel.processSignalingMessage(answer);
          });
        },
        video: stream.hasVideo() && (options.video !== false),
        audio: stream.hasAudio() && (options.audio !== false),
        iceServers: self.getIceServers(),
        stunServerUrl: self.connSettings.stun,
        turnServer: self.connSettings.turn,
        maxAudioBW: options.maxAudioBW,
        maxVideoBW: options.maxVideoBW,
        videoCodec: options.videoCodec
      });
      stream.channel.addStream(stream.mediaStream);
    } else {
      return safeCall(onFailure, 'already published');
    }
  };

  WoogeenConference.prototype.mix = function(stream, onSuccess, onFailure) {
    if (!(stream instanceof Woogeen.LocalStream)) {
      return safeCall(onFailure, 'invalid stream');
    }
    sendMsg(this.socket, 'addToMixer', stream.id(), function (err) {
      if (err) { return safeCall(onFailure, err); }
      safeCall(onSuccess, null);
    });
  };

  WoogeenConference.prototype.unmix = function(stream, onSuccess, onFailure) {
    if (!(stream instanceof Woogeen.LocalStream)) {
      return safeCall(onFailure, 'invalid stream');
    }
    sendMsg(this.socket, 'removeFromMixer', stream.id(), function (err) {
      if (err) { return safeCall(onFailure, err); }
      safeCall(onSuccess, null);
    });
  };

  //TODO: fill return description and type
/**
   * @function unpublish
   * @instance
   * @desc This function unpublishes the local stream. ‘stream-removed’ event would be triggered when the stream is removed from server.
   * @memberOf Woogeen.ConferenceClient
   * @param {stream} stream Stream to un-publish.
   * @param {function} onSuccess (optional) Success callback.
   * @param {function} onFailure (optional) Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.unpublish(localStream, function (st) {
    L.Logger.info('stream unpublished:', st.id());
  }, function (err) {
    L.Logger.error('unpublish failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.unpublish = function (stream, onSuccess, onFailure) {
    var self = this;
    if (!(stream instanceof Woogeen.LocalStream)) {
      return safeCall(onFailure, 'invalid stream');
    }
    sendMsg(self.socket, 'unpublish', stream.id(), function (err) {
      if (err) {return safeCall(onFailure, err);}
      if (stream.channel && typeof stream.channel.close === 'function') {
        stream.channel.close();
        stream.channel = null;
      }
      delete self.localStreams[stream.id()];
      stream.id = function () {return null;};
      stream.signalOnPlayAudio = undefined;
      stream.signalOnPauseAudio = undefined;
      stream.signalOnPlayVideo = undefined;
      stream.signalOnPauseVideo = undefined;
      delete stream.unpublish;
      safeCall(onSuccess, null);
    });
  };

  /*
  options: {
    audio: true/false,
    video: true/false,
    videoCodec: 'h264' // not for p2p room
  }
  */
  //TODO: fill return description and type
/**
   * @function subscribe
   * @instance
   * @desc This function subscribes to a remote stream. The stream should be a RemoteStream instance.
<br><b>Remarks:</b><br>
{<br>
video: true/false,<br>
audio: true/false,<br>
videoCodec: ‘h264’/’vp8’ // not for p2p room<br>
}
   * @memberOf Woogeen.ConferenceClient
   * @param {stream} stream Stream to subscribe.
   * @param {string} options (optional)Subscribe options.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.subscribe(remoteStream, function (st) {
    L.Logger.info('stream subscribed:', st.id());
  }, function (err) {
    L.Logger.error('subscribe failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.subscribe = function (stream, options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }
    if (!(stream instanceof Woogeen.RemoteStream)) {
      return safeCall(onFailure, 'invalid stream');
    }
    if (self.p2p) {
      internalDispatcher.on('p2p-stream-subscribed', function p2pStreamHandler (evt) {
        internalDispatcher.removeEventListener('p2p-stream-subscribed', p2pStreamHandler);
        safeCall(onSuccess, evt.stream);
      });
      sendSdp(self.socket, 'subscribe', {streamId: stream.id()}, null, function () {});
      return;
    }

    stream.channel = createChannel({
      callback: function (offer) {
        if (JSON.parse(offer).messageType !== 'OFFER') {return;} // filter out 'sendOK'
        sendSdp(self.socket, 'subscribe', {
          streamId: stream.id(),
          audio: stream.hasAudio(),
          video: stream.hasVideo()
        }, offer, function (answer, errText) {
          if (answer === 'error' || answer === 'timeout') {
            return safeCall(onFailure, errText || answer);
          }
          stream.channel.processSignalingMessage(answer);
        });
      },
      audio: stream.hasAudio() && (options.audio !== false),
      video: stream.hasVideo() && (options.video !== false),
      iceServers: self.getIceServers(),
      stunServerUrl: self.connSettings.stun,
      turnServer: self.connSettings.turn,
      videoCodec: options.videoCodec
    });

    stream.channel.onaddstream = function (evt) {
      stream.mediaStream = evt.stream;
      if(navigator.appVersion.indexOf('Trident') > -1){
        stream.pcid = evt.pcid;
      }
      safeCall(onSuccess, stream);
      stream.signalOnPlayAudio = function (onSuccess, onFailure) {
        sendCtrlPayload(self.socket, 'audio-in-on', stream.id(), onSuccess, onFailure);
      };
      stream.signalOnPauseAudio = function (onSuccess, onFailure) {
        sendCtrlPayload(self.socket, 'audio-in-off', stream.id(), onSuccess, onFailure);
      };
      stream.signalOnPlayVideo = function (onSuccess, onFailure) {
        sendCtrlPayload(self.socket, 'video-in-on', stream.id(), onSuccess, onFailure);
      };
      stream.signalOnPauseVideo = function (onSuccess, onFailure) {
        sendCtrlPayload(self.socket, 'video-in-off', stream.id(), onSuccess, onFailure);
      };
    };

    stream.channel.oniceconnectionstatechange = function (state) {
      if (state === 'failed') {
        sendMsg(self.socket, 'unsubscribe', stream.id(), function () {}, function () {});
        stream.close();
        stream.signalOnPlayAudio = undefined;
        stream.signalOnPauseAudio = undefined;
        stream.signalOnPlayVideo = undefined;
        stream.signalOnPauseVideo = undefined;
        safeCall(onFailure, 'peer connection failed');
      }
    };
  };

  //TODO: fill explanation for parameter 'param'
/**
   * @function unsubscribe
   * @instance
   * @desc This function unsubscribes the remote stream.
   * @memberOf Woogeen.ConferenceClient
   * @param {stream} stream Stream to unsubscribe.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.unsubscribe(remoteStream, function (st) {
    L.Logger.info('stream unsubscribed:', st.id());
  }, function (err) {
    L.Logger.error('unsubscribe failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.unsubscribe = function (stream, onSuccess, onFailure) {
    var self = this;
    if (!(stream instanceof Woogeen.RemoteStream)) {
      return safeCall(onFailure, 'invalid stream');
    }
    sendMsg(self.socket, 'unsubscribe', stream.id(), function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      stream.close();
      stream.signalOnPlayAudio = undefined;
      stream.signalOnPauseAudio = undefined;
      stream.signalOnPlayVideo = undefined;
      stream.signalOnPauseVideo = undefined;
      safeCall(onSuccess, resp);
    });
  };
/**
   * @function onMessage
   * @instance
   * @desc This function is the shortcut of on(‘message-received’, callback). 
<br><b>Remarks:</b><br>Once the message is received, this function is invoked.
   * @memberOf Woogeen.ConferenceClient
   * @param {function} callback callback function to the message.
   * @example
<script type="text/JavaScript”>
  var conference = Woogeen.ConferenceClient.create({});
// ……
  conference.onMessage(function (event) {
    L.Logger.info('Message Received:', event.msg);
  });
</script>
   */
  WoogeenConference.prototype.onMessage = function (callback) {
    if (typeof callback === 'function') {
      this.on('message-received', callback);
    }
  };
/**
   * @function shareScreen
   * @instance
   * @desc This function creates a LocalStream from screen and publishes it to the　server. The options are similar to that used to create a LocalStream.
   * @memberOf Woogeen.ConferenceClient
   * @param {string} options (optional)Share screen options.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.shareScreen(options, function (stream) {
    L.Logger.info('screen shared:', stream.id());
  }, function (err) {
    L.Logger.error('screen share failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.shareScreen = function (option, onSuccess, onFailure) {
    var self = this;
    if (typeof option === 'function') {
      onFailure = onSuccess;
      onSuccess = option;
      option = {};
    }
    option = option || {};
    Woogeen.LocalStream.create({
      video: {
        device: 'screen',
        resolution: option.resolution,
        frameRate: option.frameRate
      },
      audio: false
    }, function (err, stream) {
      if (err) {
        return safeCall(onFailure, err);
      }
      self.publish(stream, function (st) {
        safeCall(onSuccess, st);
      }, function (err) {
        safeCall(onFailure, err);
      });
    });
  };

  //TODO: fill return description and type
/**
   * @function startRecorder
   * @instance
   * @desc This function starts the mixed audio stream and video stream recording on the conference room and saves it to a .mkv file on the server, according to the configurable “config.erizoController.recording_path”. The options are reserved currently for future usage.
   <br><b>Remarks:</b><br>
   options: {<br>
    streamId: xxxxxx,<br>
    recorderId: yyyyyy<br>
  }
   * @memberOf Woogeen.ConferenceClient
   * @param {string} options (optional)Media recorder options.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.startRecorder({to: streamId}, function (file) {
    L.Logger.info('Stream recorded with recorder ID: ', file.id);
  }, function (err) {
    L.Logger.error('Media recorder failed:', err);
  }
);
</script>
   */
  WoogeenConference.prototype.startRecorder = function (options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }

    sendMsg(self.socket, 'startRecorder', options, function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      safeCall(onSuccess, resp);
    });
  };

//TODO: fill return description and type
/**
   * @function stopRecorder
   * @instance
   * @desc This function stops the mixed audio stream and video stream recording on　the conference room and saves it to a .mkv file on the server, according to　the configurable “config.erizoController.recording_path”.
   <br><b>Remarks:</b><br>
   options: {<br>
    recorderId: xxxxxx<br>
  }
   * @memberOf Woogeen.ConferenceClient
   * @param {string} options (optional)Media recorder options.
   * @param {function} onSuccess (optional)Success callback.
   * @param {function} onFailure (optional)Failure callback.
   * @return {TYPE} DESCRIPTION
   * @example
<script type="text/JavaScript”>
var conference = Woogeen.ConferenceClient.create({});
// ……
conference.stopRecorder({id: recorderId}, function (file) {
    L.Logger.info('Recorded stream to ', file.path);
  }, function (err) {
    L.Logger.error('Media recorder cannot stop with failure: ', err);
  }
);
</script>
 */
  WoogeenConference.prototype.stopRecorder = function (options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }

    sendMsg(self.socket, 'stopRecorder', options, function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      safeCall(onSuccess, resp);
    });
  };

  WoogeenConference.prototype.getRegion = function (options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }

    sendMsg(self.socket, 'getRegion', options, function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      safeCall(onSuccess, resp);
    });
  };

  WoogeenConference.prototype.setRegion = function (options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }

    sendMsg(self.socket, 'setRegion', options, function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      safeCall(onSuccess, resp);
    });
  };

  WoogeenConference.prototype.setVideoBitrate = function (options, onSuccess, onFailure) {
    var self = this;
    if (typeof options === 'function') {
      onFailure = onSuccess;
      onSuccess = options;
      options = {};
    } else if (typeof options !== 'object' || options === null) {
      options = {};
    }

    sendMsg(self.socket, 'setVideoBitrate', options, function (err, resp) {
      if (err) {return safeCall(onFailure, err);}
      safeCall(onSuccess, resp);
    });
  };

/**
   * @function create
   * @desc This factory returns a Woogeen.ConferenceClient object.
   * @memberOf Woogeen.ConferenceClient
   * @static
   * @return {Woogeen.ConferenceClient} An instance of Woogeen.ConferenceClient.
   * @example
var conference = Woogeen.ConferenceClient.create({});
   */
  WoogeenConference.create = function factory (spec) { // factory, not in prototype
    return new WoogeenConference(spec);
  };

  return WoogeenConference;
}());
