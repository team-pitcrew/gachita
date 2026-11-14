import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoarding, remainingTime, boardingToken } from './boarding.js';
import { boardingUrl, createVehicleBoarding } from './vehicle-boarding.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; }
  append(...children) { for (const child of children) { child?.remove?.(); if (child instanceof Element) child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach((child) => { if (child instanceof Element) child.parent = null; }); this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
}
const elements = (el) => [el, ...el.children.filter((child) => child instanceof Element).flatMap(elements)];
const content = (el) => el instanceof Element ? el.children.map(content).join(' ') : String(el);
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const origin = 'https://gachita.test';
const opaque = 'opaque_boarding_invitation_12345';
function fixture(t) {
  const storage=new Map();
  const body = new Element('body'), timers = [], calls = [], joined = [], decisions = [], left = [];
  const descriptors = new Map(['document','location','history','sessionStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.sessionStorage={getItem:(key)=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:(key)=>storage.delete(key)};
  globalThis.document = { body, hidden:false, createElement:(tag)=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag) };
  globalThis.location = { href:`${origin}/?join=${opaque}`, origin };
  globalThis.history = { replaceState:(_,__,url)=>{globalThis.location.href=String(url);} };
  t.mock.method(globalThis,'setInterval',(fn)=>{timers.push(fn);return timers.length;});
  t.mock.method(globalThis,'setTimeout',()=>0);t.mock.method(globalThis,'clearTimeout',()=>{});t.mock.method(globalThis,'clearInterval',()=>{});
  let now=1_800_000_000_000;t.mock.method(Date,'now',()=>now);
  const profile={id:'profile',name:'동승자',character:'basic'};
  const participant={id:'person',profileId:profile.id,consent:false,seat:'ROW_2_LEFT'};
  const trip={code:'TRIP12',title:'바다 여행',status:'boarding',generation:1,participants:[participant]};
  const preview={title:trip.title,seats:['ROW_2_LEFT','ROW_1_RIGHT'],expiresAt:now+300_000};
  const invite={id:'invite-id',url:`/?join=${opaque}`,expiresAt:preview.expiresAt};
  const data={respond:null};
  t.mock.method(globalThis,'fetch',async(path,options)=>{
    calls.push({path,...options});if(data.respond)return data.respond(path,options);
    if(options.method==='DELETE')return new Response(null,{status:204});
    if(options.method==='PATCH'){participant.consent=JSON.parse(options.body).consent;return Response.json(participant);}
    if(path.endsWith('/boarding-invites')&&options.method==='POST')return Response.json(invite,{status:201});
    if(path.endsWith('/participants'))return Response.json({tripCode:trip.code,participant,token:'phone-only-token'},{status:201});
    if(path.includes('/boarding-invites/'))return Response.json(preview);
    return Response.json(trip);
  });
  const boarding=createBoarding({getProfile:()=>profile,getToken:()=>'profile-token',consentText:['동의 안내'],consentOffMessage:'동의를 끌까요?',onLinked:(v)=>joined.push(v),onDecision:(v)=>decisions.push(v),onLeave:(v)=>left.push(v)});
  const car=createVehicleBoarding({getTrip:()=>trip,getToken:()=>'driver-token',getOrigin:()=>origin});
  t.after(()=>{boarding.close();trip.status='ended';car.sync();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {boarding,car,body,profile,participant,trip,preview,invite,data,calls,joined,decisions,left,now:(v)=>{now=v;},tick:async()=>{for(const fn of timers)fn();await new Promise(setImmediate);},
    button:(label)=>elements(body).find((el)=>el.tag==='button'&&content(el)===label),
    choose:(seat)=>elements(body).find((el)=>el.tag==='input'&&el.value===seat).onchange(),
    qr:()=>elements(body).find((el)=>el.attrs['data-payload']),
  };
}

test('QR URL은 같은 서비스의 초대만 읽고 인증 토큰이나 다른 사이트로 이동하지 않는다',()=>{
  assert.equal(boardingToken(`${origin}/?join=${opaque}`,origin),opaque);
  for(const bad of [`https://other.test/?join=${opaque}`,`${origin}/?join=x`,`${origin}/profile?join=${opaque}`])assert.equal(boardingToken(bad,origin),null);
  assert.equal(boardingUrl(`/?join=${opaque}`,origin),`${origin}/?join=${opaque}`);
  assert.throws(()=>boardingUrl(`https://other.test/?join=${opaque}`,origin));
});
test('차량이 QR을 발급하고 만료되면 스캔 가능한 SVG를 제거한다',async(t)=>{
  const f=fixture(t);await f.car.open();assert.equal(f.qr().attrs['data-payload'],`${origin}${f.invite.url}`);
  assert.equal(remainingTime(f.invite.expiresAt),'05:00');assert.equal(f.calls[0].headers.authorization,'Bearer driver-token');
  f.now(f.invite.expiresAt);await f.tick();assert.equal(f.qr(),undefined);assert.ok(content(f.body).includes('QR을 다시 열어 주세요'));
});
test('차에서 닫으면 서버 초대를 폐기하고 주행 전환 때도 QR을 숨긴다',async(t)=>{
  const f=fixture(t);await f.car.open();await f.button('닫기').onclick();assert.equal(f.body.children.length,0);
  assert.equal(f.calls.at(-1).method,'DELETE');assert.equal(f.calls.at(-1).path,'/api/trips/TRIP12/boarding-invites/invite-id');
  await f.car.open();f.trip.status='driving';f.car.sync();assert.equal(f.qr(),undefined);assert.equal(f.body.children.length,0);
});
test('휴대폰은 차 QR을 조회하고 선택한 자리로 참가한 뒤 자기 토큰으로만 동의한다',async(t)=>{
  const f=fixture(t);await f.boarding.open();assert.equal(f.qr(),undefined);assert.equal(f.calls[0].headers.authorization,undefined);
  assert.equal(f.calls.filter((c)=>c.method==='POST').length,0);f.choose('ROW_2_LEFT');await f.button('이 자리로 함께 타기').onclick();
  const join=f.calls.find((c)=>c.method==='POST');assert.equal(join.path,`/api/boarding-invites/${opaque}/participants`);assert.deepEqual(JSON.parse(join.body),{seat:'ROW_2_LEFT'});assert.equal(join.headers.authorization,'Bearer profile-token');
  assert.equal(f.calls.filter((c)=>c.method==='PATCH').length,0);assert.equal(f.joined[0].token,'phone-only-token');assert.equal(f.joined[0].code,'TRIP12');
  await f.button('기록에 동의하기').onclick();const patch=f.calls.find((c)=>c.method==='PATCH');assert.equal(patch.headers.authorization,'Bearer phone-only-token');assert.deepEqual(JSON.parse(patch.body),{consent:true});
  assert.ok(content(f.body).includes('내 기록 동의 켜짐'));f.button('여행으로 돌아가기').onclick();assert.equal(f.left[0].code,'TRIP12');
});
test('기록 없이 참여하면 동의는 꺼진 채 합석한다',async(t)=>{
  const f=fixture(t);await f.boarding.open();f.choose('ROW_2_LEFT');await f.button('이 자리로 함께 타기').onclick();await f.button('기록 없이 함께 타기').onclick();
  assert.equal(f.participant.consent,false);assert.equal(f.decisions.length,1);assert.ok(content(f.body).includes('내 기록 동의 꺼짐'));
});
test('좌석 충돌 뒤 성공 화면을 만들지 않고 빈자리를 다시 조회한다',async(t)=>{
  const f=fixture(t);await f.boarding.open();f.choose('ROW_2_LEFT');f.data.respond=()=>Response.json({error:'좌석 충돌'},{status:409});await f.button('이 자리로 함께 타기').onclick();
  assert.equal(f.joined.length,0);assert.ok(content(f.body).includes('다른 동승자가 먼저'));f.preview.seats=['ROW_1_RIGHT'];f.data.respond=null;await f.button('다시 확인').onclick();assert.equal(f.button('이 자리로 함께 타기').disabled,true);
});
for(const change of ['close','profile'])test(`휴대폰 조회 중 ${change} 변경 뒤 늦은 응답을 표시하지 않는다`,async(t)=>{
  const f=fixture(t),pending=defer();f.data.respond=()=>pending.promise;const wait=f.boarding.open();if(change==='close')f.boarding.close();else{f.profile.id='other';f.boarding.sync();}
  pending.resolve(Response.json(f.preview));await wait;assert.equal(f.body.children.length,0);assert.equal(f.joined.length,0);
});
test('만료 또는 조회 오류 뒤 폰은 참여 성공을 표시하지 않는다',async(t)=>{
  const f=fixture(t);f.data.respond=()=>Response.json({error:'expired'},{status:410});await f.boarding.open();assert.equal(f.button('이 자리로 함께 타기'),undefined);assert.ok(content(f.body).includes('만료됐거나'));
  f.data.respond=null;await f.button('다시 확인').onclick();f.now(f.preview.expiresAt);await f.tick();assert.equal(f.button('이 자리로 함께 타기'),undefined);
});

test('참여 응답을 잃은 뒤 다시 열어도 이미 찬 자리로 멱등 재확인한다',async(t)=>{
  const f=fixture(t);await f.boarding.open();f.choose('ROW_2_LEFT');f.data.respond=()=>{throw new Error('connection lost');};await f.button('이 자리로 함께 타기').onclick();
  f.boarding.close();f.preview.seats=[];f.data.respond=null;await f.boarding.open();
  assert.equal(f.button('참여 결과 다시 확인').disabled,false);await f.button('참여 결과 다시 확인').onclick();assert.equal(f.joined[0].participant.seat,'ROW_2_LEFT');assert.equal(f.joined[0].participant.consent,false);
});
test('가입 응답 대기 중 만료되어도 화면 오류나 거짓 참가 결과가 생기지 않는다',async(t)=>{
  const f=fixture(t);await f.boarding.open();f.choose('ROW_2_LEFT');const pending=defer();f.data.respond=()=>pending.promise;const joining=f.button('이 자리로 함께 타기').onclick();
  f.now(f.preview.expiresAt);await f.tick();pending.resolve(Response.json({error:'expired'},{status:410}));await joining;
  assert.equal(f.joined.length,0);assert.equal(f.button('이 자리로 함께 타기'),undefined);assert.ok(content(f.body).includes('QR이 만료됐어요'));
});

test('연결 완료 화면도 다른 기기에서 바뀐 동의를 다시 반영한다',async(t)=>{
  const f=fixture(t);await f.boarding.open();f.choose('ROW_2_LEFT');await f.button('이 자리로 함께 타기').onclick();await f.button('기록에 동의하기').onclick();
  const changed={...f.participant,consent:false};f.boarding.openConsent({...f.trip,participants:[changed]},changed,'phone-only-token');
  assert.ok(content(f.body).includes('대화를 기록할까요?'));assert.ok(!content(f.body).includes('내 기록 동의 켜짐'));
});
