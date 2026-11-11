// Italian time: summer time from the last Sunday of March to the last Sunday of October, at 01:00 UTC.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {italianSummerTime,ITALY_OFFSET,MotionClock} from './clock.js';
test('summer time follows the European Union dates',()=>{
  assert.equal(ITALY_OFFSET,3600);
  assert.equal(italianSummerTime(Date.UTC(2026,10,9,19,45)),false,'9 November 2026, 20:45 in Italy: winter time');
  assert.equal(italianSummerTime(Date.UTC(2026,2,29,0,59)),false,'29 March 2026, the last Sunday: until 01:00 UTC still winter');
  assert.equal(italianSummerTime(Date.UTC(2026,2,29,1,0)),true,'from 01:00 UTC summer time');
  assert.equal(italianSummerTime(Date.UTC(2026,9,25,0,59)),true,'25 October 2026, the last Sunday');
  assert.equal(italianSummerTime(Date.UTC(2026,9,25,1,0)),false);
  assert.equal(italianSummerTime(Date.UTC(2027,2,28,1,0)),true,'2027: 28 March');
  assert.equal(italianSummerTime(Date.UTC(2027,9,31,0,30)),true,'2027: 31 October, before 01:00 UTC');
  assert.equal(italianSummerTime(Date.UTC(2027,9,31,1,0)),false);
  assert.equal(italianSummerTime(Date.UTC(2026,6,1)),true);assert.equal(italianSummerTime(Date.UTC(2026,0,15)),false);
});
test('the motion clock still never goes backwards',()=>{
  let ticks=10;const clock=new MotionClock(()=>ticks,(a,b)=>b-a);ticks=60;assert.equal(clock.now(),50);ticks=40;assert.ok(Number.isNaN(clock.now()));
});
