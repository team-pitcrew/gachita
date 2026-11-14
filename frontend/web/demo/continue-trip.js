export function joinedTrip(storage) {
  try {
    const code = storage.getItem('gachita:trip')?.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code || '')) return null;
    const id = storage.getItem(`gachita:${code}`), token = storage.getItem(`gachita:${code}:token`);
    return id && token ? { code, id, token } : null;
  } catch { return null; }
}

export const sameJoinedTrip = (a, b) => !!a && !!b && a.code === b.code && a.id === b.id && a.token === b.token;

export async function verifyJoinedTrip(candidate, { request, current, valid = () => true, signal }) {
  const check = () => {
    signal?.throwIfAborted();
    if (!sameJoinedTrip(candidate, current()) || !valid()) throw new Error('참여한 여행이 바뀌었어요. 다시 선택해 주세요.');
  };
  try {
    check();
    const me = await request('GET', `/trips/${candidate.code}/me`, null, candidate.token, signal);
    check();
    if (me?.id !== candidate.id) throw new Error('저장된 참가자와 현재 연결이 달라요. 휴대폰 화면에서 참여 연결을 확인해 주세요.');
    const trip = await request('GET', `/trips/${candidate.code}`, null, candidate.token, signal);
    check();
    if (trip?.code !== candidate.code || !Array.isArray(trip.participants) || !trip.participants.some((person) => person.id === me.id)) throw new Error('이 여행의 참가자를 찾을 수 없어요. 휴대폰 화면에서 참여 연결을 확인해 주세요.');
    return { car: { code: candidate.code, id: me.id, token: candidate.token }, trip };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.status === 401 || error.status === 403) throw new Error('참여 연결이 만료됐어요. 휴대폰 화면에서 다시 연결해 주세요.');
    if (error.status === 404) throw new Error('참여한 여행을 찾을 수 없어요. 휴대폰 화면에서 여행을 확인해 주세요.');
    throw error;
  }
}
