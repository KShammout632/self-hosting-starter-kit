// docker-modem loads ssh2 for ssh:// Docker hosts. The agent only uses the local socket.
exports.Client = class Client {
  constructor() {
    throw new Error('ssh is not supported');
  }
};
