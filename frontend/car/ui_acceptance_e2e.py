"""T83 화면 인수 검사. e2e.py와 같은 격리 서버/AVD 환경 변수로 실행합니다.
호스트 마이크는 끄고 macOS Yuna 합성 음성만 씁니다. 실제 휴대폰/실차 검사가 아닙니다.
실행: python3 frontend/car/ui_acceptance_e2e.py unused <저장소 밖 결과 경로>
설치된 디버그 앱의 시험 데이터를 비웁니다. APK 설치는 먼저 수행합니다.
"""
import sys,time,threading,json,pathlib
import e2e as e, capture_e2e as c
from gleo_e2e import ours_recording
out=e.OUT;out.mkdir(parents=True,exist_ok=True)
threading.Thread(target=e.heartbeat,daemon=True).start()
inj=c.Injector()
c.fixture('acceptance', [('아들','화장실 가고 싶어'),('아빠','아니, 나중에 갈게'),('딸','아빠 바다는 언제 보여?')],seconds=70,lead=12,tail=12)
e.gear('Park'); e.adb('shell','am','force-stop','--user','10',e.PKG);e.adb('shell','pm','clear','--user','10',e.PKG)
for perm in ['RECORD_AUDIO','POST_NOTIFICATIONS']:e.adb('shell','pm','grant','--user','10',e.PKG,'android.permission.'+perm)
e.adb('shell','am','start','--user','10','-n',e.PKG+'/.MainActivity','--es','server',f'http://10.0.2.2:{e.PORT}')
c.wait_texts(lambda u:e.SETUP in u,20);e.shot('01-setup');e.tap_make();time.sleep(4)
code=e.trip_code();e.shot('02-boarding');e.note('trip',code=code)
phone=e.phone_join(code);time.sleep(12);e.tap_switch();e.phone_consent(code,phone,True)
error=[]
def inject():
 try:
  end=time.monotonic()+20
  while not ours_recording() and time.monotonic()<end:time.sleep(.05)
  if not ours_recording():raise RuntimeError('recording did not open')
  inj.play('acceptance')
 except Exception as ex:error.append(str(ex))
t=threading.Thread(target=inject,daemon=True);t.start()
c.wait_texts(lambda u:'● 기록 중' in u,10);e.gear('Drive');e.shot('03-drive')
u=c.wait_texts(lambda u:any('들를까요' in x for x in u),35);e.note('offer-ui',texts=u);e.check('합성 부탁을 받아 적고 휴게소 제안',any('들를까요' in x for x in u));e.shot('04-offer')
t.join(timeout=90);e.check('합성 음성 주입 완료',not t.is_alive() and not error)
e.gear('Park');time.sleep(2);e.shot('05-park');u=e.texts();e.note('park-ui',texts=u)
e.tap_text('대화 기록');time.sleep(4);e.shot('06-conversation');e.note('conversation-ui',texts=e.texts());e.tap_text('열기');time.sleep(2);u=e.texts();e.shot('07-transcript');e.note('transcript-ui',texts=u);e.check('주차 중 서버 대화 3개 전체 열기', any('화장실' in x for x in u) and any('나중에' in x for x in u) and any('바다' in x for x in u))
e.tap_text('함께 타는 중');time.sleep(1);e.tap_switch()
(out/'results.json').write_text(json.dumps({'log':e.log,'synthetic':True,'real_phone':False},ensure_ascii=False,indent=2))
fails=[x['name'] for x in e.log if x.get('step')=='check' and not x['ok']]
print('failed',fails)
sys.exit(1 if fails else 0)
