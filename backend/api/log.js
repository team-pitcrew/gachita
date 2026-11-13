// 구조화 로그(T71): 표준 출력에 사건마다 JSON 한 줄. 컨테이너 로그를 그대로 jq나 CloudWatch Logs Insights로 읽는다.
// 공통 칸: t(ISO 시각), level(info·warn·error), msg(사건 이름, snake_case). 나머지는 사건마다.
// 남기지 않는 것: 토큰, 이름, 발화 글자, 요청 본문, 질의 문자열. 경로는 틀로만(코드·id는 :p).
let out = (line) => process.stdout.write(`${line}\n`);

export const log = (level, msg, fields = {}) => out(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));

// 시험이 줄을 받아 본다. 돌려받은 함수로 원래대로 되돌린다.
export const captureLog = (fn) => {
  const before = out;
  out = fn;
  return () => (out = before);
};

// 오류를 로그 칸으로. 스택은 서버 쪽 오류(5xx)에만 붙인다.
export const errFields = (e, withStack = false) => ({
  ...(e?.name && { name: e.name }),
  ...(e?.code && { code: e.code }),
  ...(e?.message && { message: e.message }),
  ...(withStack && e?.stack && { stack: e.stack }),
});
