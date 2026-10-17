// 서버는 127.0.0.1에서만 열리지만, 같은 맥의 브라우저에서 열린 다른 사이트도 이 주소로 요청을 보낼 수 있다.
// Host가 이 맥 주소가 아니면(DNS 리바인딩) 거절하고, Origin이 있으면 voin 화면과 같은 출처일 때만 받는다.
// 맥 앱(URLRequest)과 승인 MCP(Node fetch)는 Origin 없이 보낸다.
export function isLocalRequest({ host, origin }, port) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!hosts.includes(host)) return false;
  return origin === undefined || hosts.some((h) => origin === `http://${h}`);
}
