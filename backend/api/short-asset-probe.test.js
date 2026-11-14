import assert from 'node:assert/strict';
import {test} from 'node:test';
import {measuredVideo,inspectVideo,ASSET_MAX_BYTES} from './providers/short-asset-probe.js';
const probe=()=>({format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[
 {index:0,codec_type:'video',codec_name:'h264',width:1080,height:1920,avg_frame_rate:'30/1',nb_read_frames:'900'},
 {index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2,nb_read_frames:'1407'},
],packets:[{stream_index:0,pts_time:'0',duration_time:'30'},{stream_index:1,pts_time:'-0.02',duration_time:'30.02'}]});
test('ffprobe가 측정한 MP4·WebM 트랙과 프레임·길이·해상도를 사용합니다',()=>{
 const actual=measuredVideo(probe(),'video/mp4',30);
 assert.deepEqual([actual.width,actual.height,actual.fps,actual.seconds,actual.audioSampleRate],[1080,1920,30,30,48000]);
 const webm=probe();webm.format.format_name='matroska,webm';webm.streams[0].codec_name='vp9';webm.streams[1].codec_name='opus';
 assert.equal(measuredVideo(webm,'video/webm',30).audioCodec,'opus');
});
test('위조된 형식과 비디오·음성 누락, 잘린 소리, 과도한 해상도와 빈 프레임을 거절합니다',()=>{
 for(const change of [p=>p.streams.pop(),p=>p.streams.shift(),p=>p.streams.push({...p.streams[0]}),p=>p.format.format_name='mpegts',p=>p.streams[0].width=3840,p=>p.streams[0].nb_read_frames='0',p=>p.streams[0].avg_frame_rate='120/1',p=>p.packets[1].duration_time='2',p=>p.packets=[],p=>p.streams[1].channels=6,p=>p.packets[0].pts_time="1000",p=>p.packets[1].pts_time="-10"]){
  const p=probe();change(p);assert.throws(()=>measuredVideo(p,'video/mp4',30),e=>e.status===400);
 }
 assert.throws(()=>measuredVideo(probe(),'video/mp4',15),e=>e.status===400);
});
test('미디어 매직과 크기를 외부 검사 도구보다 먼저 확인합니다',async()=>{
 await assert.rejects(inspectVideo(Buffer.from('not-a-real-video-container'),'video/mp4',30),e=>e.status===400);
 await assert.rejects(inspectVideo(Buffer.alloc(ASSET_MAX_BYTES+1),'video/webm',30),e=>e.status===413);
});
