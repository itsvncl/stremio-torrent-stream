import { ServerResponse } from "http";
import { pipeline, Transform } from "stream";

export const pipeTorrentStream = (
  source: NodeJS.ReadableStream,
  response: ServerResponse,
  expectedBytes: number
) => {
  const firstDataTimeout = setTimeout(() => {
    monitor.destroy(new Error("Torrent stream received no data for 10 seconds"));
  }, 10000);
  const idleTimeout = setTimeout(() => {
    monitor.destroy(new Error("Torrent stream stalled for 60 seconds"));
  }, 60000);

  let bytesRead = 0;
  const monitor = new Transform({
    transform(chunk, _encoding, callback) {
      bytesRead += chunk.byteLength;
      if (bytesRead > expectedBytes) {
        return callback(new Error(`Torrent stream exceeded the requested ${expectedBytes} bytes`));
      }
      clearTimeout(firstDataTimeout);
      idleTimeout.refresh();
      callback(null, chunk);
    },
    flush(callback) {
      if (bytesRead !== expectedBytes) {
        return callback(new Error(`Torrent stream ended early: ${bytesRead} of ${expectedBytes} bytes`));
      }
      callback();
    },
  });

  const clearTimers = () => {
    clearTimeout(firstDataTimeout);
    clearTimeout(idleTimeout);
  };
  // A WebTorrent read can still be waiting for a piece after the HTTP socket closes.
  response.once("close", clearTimers);

  pipeline(source, monitor, response, (error) => {
    clearTimers();
    response.removeListener("close", clearTimers);
    if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error(`Torrent stream failed: ${error.message}`);
    }
  });
};
