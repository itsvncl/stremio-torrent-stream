import axios from "axios";
import { RequestListener } from "http";
import https from "https";
import localtunnel from "localtunnel";
import fs from "fs-extra";

enum HttpsMethod {
  None = "none",
  LocalIpMedic = "local-ip.medicmobile.org",
  LocalIpCo = "local-ip.co",
  Localtunnel = "localtunnel",
  GeneratedCert = "generated-cert",
}

const HTTPS_METHOD = process.env.HTTPS_METHOD || HttpsMethod.None;

export const serveHTTPS = async (app: RequestListener, port: number) => {
  if (HTTPS_METHOD === HttpsMethod.LocalIpMedic) {
    const json = (await axios.get("https://local-ip.medicmobile.org/keys"))
      .data;
    const cert = `${json.cert}\n${json.chain}`;
    const httpsServer = https.createServer({ key: json.privkey, cert }, app);
    httpsServer.listen(port);
    console.log(`HTTPS (LocalIpMedic) addon listening on port ${port}`);
    return httpsServer;
  }

  if (HTTPS_METHOD === HttpsMethod.LocalIpCo) {
    const key = (await axios.get("http://local-ip.co/cert/server.key")).data;
    const serverPem = (await axios.get("http://local-ip.co/cert/server.pem"))
      .data;
    const chainPem = (await axios.get("http://local-ip.co/cert/chain.pem"))
      .data;
    const cert = `${serverPem}\n${chainPem}`;
    const httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(port);
    console.log(`HTTPS (LocalIpCo) addon listening on port ${port}`);
    return httpsServer;
  }

  if (HTTPS_METHOD === HttpsMethod.Localtunnel) {
    const tunnel = await localtunnel({ port: Number(process.env.PORT) });
    console.log(`Tunnel accessible at: ${tunnel.url}`);
    const tunnelPassword = await axios.get("https://loca.lt/mytunnelpassword");
    console.log(`Tunnel password: ${tunnelPassword.data}`);
  }

  if (HTTPS_METHOD === HttpsMethod.GeneratedCert) {
    const key = fs.readFileSync("/ssl/key.pem");
    const cert = fs.readFileSync("/ssl/cert.pem");
    const httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(port, () => {
      console.log(`HTTPS (GeneratedCert) addon listening on port ${port}`);
    });
    return httpsServer;
  }
};
