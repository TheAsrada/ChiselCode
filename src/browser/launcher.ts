/** The listener exists only in Chromium's network namespace. Its Unix peer is the
 * host-side origin filter. There is no other route out of the namespace. */
const relay = `
import os, select, socket, socketserver, sys, threading

class Relay(socketserver.ThreadingTCPServer):
    daemon_threads = True
    request_queue_size = 32
    slots = threading.BoundedSemaphore(32)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

class Channel(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.socket(socket.AF_UNIX) as peer:
                peer.settimeout(10)
                self.request.settimeout(10)
                peer.connect("/run/chisel-egress")
                sockets = [self.request, peer]
                while True:
                    ready, _, _ = select.select(sockets, [], [], 600)
                    if not ready:
                        break
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (peer if source is self.request else self.request).sendall(data)
        except OSError:
            pass

with Relay(("127.0.0.1", 16580), Channel) as server:
    if os.fork() == 0:
        for fd in range(5):
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            server.serve_forever()
        finally:
            os._exit(0)

os.execv("/opt/chromium/chrome-headless-shell",
         ["/opt/chromium/chrome-headless-shell", *sys.argv[1:]])
`;

export const proxyUrl = "http://127.0.0.1:16580";

export const chromiumLauncher = `#!/bin/sh
exec /usr/bin/bwrap --unshare-all --die-with-parent --new-session \\
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \\
  --symlink usr/bin /bin --ro-bind-try /etc/fonts /etc/fonts \\
  --ro-bind-try /etc/ld.so.cache /etc/ld.so.cache \\
  --proc /proc --dev /dev --size 268435456 --tmpfs /tmp --chdir /tmp \\
  --ro-bind "$CHISEL_BROWSER_CHROMIUM" /opt/chromium \\
  --ro-bind "$CHISEL_BROWSER_SOCKET" /run/chisel-egress \\
  --clearenv --setenv HOME /tmp --setenv PATH /usr/bin:/bin \\
  -- /usr/bin/python3 -I -c '${relay}' "$@"
`;
