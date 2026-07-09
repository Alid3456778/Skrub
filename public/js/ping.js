export function startPingIndicator(socket, dotEl, intervalMs = 2000) {
  socket.on('heartbeat-ack', (sentAt) => {
    const rtt = Date.now() - sentAt;
    dotEl.classList.remove('green', 'yellow', 'red');
    if (rtt <= 60) dotEl.classList.add('green');
    else if (rtt <= 150) dotEl.classList.add('yellow');
    else dotEl.classList.add('red');
    dotEl.title = `Ping: ${rtt}ms`;
  });

  const timer = setInterval(() => {
    if (socket.connected) socket.emit('heartbeat', Date.now());
  }, intervalMs);

  return () => clearInterval(timer);
}
