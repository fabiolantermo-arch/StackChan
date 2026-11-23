// The MOD's main function must fit the robot's JavaScript stack (scripts/mod-frame.mjs; 21 Nov 2026: at 446 names the
// robot started, at 447 it stopped at every start with «stack overflow (-1)!», and no test on the Mac saw it).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {measure} from '../../scripts/mod-frame.mjs';
const LIMIT=446,BUDGET=430; // the limit measured on the robot; the budget leaves room for what was not measured
test('startRobottino stays within the robot\'s JavaScript stack: fixed numbers go in K, new behaviour in its own module',()=>{
  const m=measure(readFileSync(new URL('./mod.js',import.meta.url),'utf8'));
  assert.ok(m.frame<=BUDGET,`startRobottino needs ${m.frame} stack slots (${m.own} names of its own + ${m.module} of the module); the robot stops at every start from ${LIMIT+1}. Budget ${BUDGET}: put fixed numbers in K and new behaviour in a module of its own.`);
});
test('the count sees what makes the frame: own names, and module names used even only by functions inside',()=>{
  const m=measure('import {a,b,c} from "x";const top=1;let unused=2;function startRobottino(robot){const one=a,two=()=>b+top;let three;return [one,two,three];}');
  assert.deepEqual({own:m.own,module:m.module,names:m.usedModuleNames},{own:4,module:3,names:['a','b','top']});
});
