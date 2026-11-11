// The tilted portrait (imitation): which square of the upright picture goes where, and how many pieces one update
// of the screen may ask for. Pure arithmetic: no display.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tiltLevel,drawTilted,mouthBands,TILT_CELL,TILT_COLUMNS,TILT_ROWS,TILT_BAND,TILT_BANDS,TILT_LEVELS,TILT_DEGREES,TILT_DRAWS} from './tilt.js';
import {MOUTH_BOXES} from './portrait-state.js';
const BASE='base',MOUTH='mouth';
const pieces=(level,row,rows,box)=>{const list=[];const count=drawTilted((texture,x,y,sx,sy,width,height)=>list.push({texture,x,y,sx,sy,width,height}),level,row,rows,BASE,box?MOUTH:undefined,box);assert.equal(count,list.length);return list;};
const levels=[];for(let level=-TILT_LEVELS;level<=TILT_LEVELS;level++)levels.push(level);
test('the bands cover the screen',()=>{
  assert.equal(TILT_COLUMNS*TILT_CELL,320);assert.equal(TILT_ROWS*TILT_CELL,240);assert.equal(TILT_BANDS*TILT_BAND,TILT_ROWS);
});
test('upright, every square stays where it is',()=>{
  const list=pieces(0,0,TILT_ROWS,undefined);
  assert.equal(list.length,TILT_DRAWS-1); // the whole picture does not fit one update: it stops before the limit
  for(let band=0;band<TILT_BANDS;band++){
    const row=pieces(0,band*TILT_BAND,TILT_BAND,undefined);
    assert.equal(row.length,TILT_COLUMNS*TILT_BAND);
    for(const piece of row)assert.deepEqual([piece.sx,piece.sy,piece.width,piece.height,piece.texture],[piece.x,piece.y,TILT_CELL,TILT_CELL,BASE]);
  }
});
test('a band never asks for more pieces than one update can take',()=>{
  let most=0;
  for(const level of levels)for(const box of [undefined,...Object.values(MOUTH_BOXES)])for(let band=0;band<TILT_BANDS;band++){
    const count=pieces(level,band*TILT_BAND,TILT_BAND,box).length;
    if(count>most)most=count;
  }
  // The limit of drawTilted is never reached by a band (a band cut short would leave a hole), and the limit itself
  // is well under the host's list (4096 bytes, 20 a piece, plus the background and the rest of the screen).
  assert.ok(most<TILT_DRAWS-1,`most pieces in a band: ${most}`);
  console.log(`most pieces in a band: ${most}`);
  assert.ok(TILT_DRAWS*20+200<4096);
});
test('each square comes from where a real rotation around the neck would take it',()=>{
  for(const level of levels){
    const angle=level*TILT_DEGREES*Math.PI/180,sin=Math.sin(angle),cos=Math.cos(angle);
    for(const piece of pieces(level,0,TILT_BAND,undefined).concat(pieces(level,TILT_ROWS-TILT_BAND,TILT_BAND,undefined))){
      const u=piece.x+4-160,v=piece.y+4-200;
      assert.ok(Math.abs(piece.sx+4-(160+u*cos+v*sin))<=1&&Math.abs(piece.sy+4-(200+v*cos-u*sin))<=1,`level ${level} at ${piece.x},${piece.y}`);
    }
  }
  // Positive is clockwise for who looks at the screen: the top of the picture moves to the right, so the square at
  // the top centre shows what the upright picture has to its left.
  const top=pieces(TILT_LEVELS,0,1,undefined).find(piece=>piece.x===160);
  assert.ok(top.sx<130);
  assert.ok(pieces(-TILT_LEVELS,0,1,undefined).find(piece=>piece.x===160).sx>190);
});
test('beyond the turned picture nothing is drawn: the background stays',()=>{
  const list=pieces(TILT_LEVELS,0,TILT_BAND,undefined);
  assert.ok(list.length<TILT_COLUMNS*TILT_BAND);
  for(const piece of list)assert.ok(piece.sx>-TILT_CELL&&piece.sy>-TILT_CELL&&piece.sx<320&&piece.sy<240);
});
test('the mouth picture covers its place in the turned portrait',()=>{
  for(const [style,box] of Object.entries(MOUTH_BOXES))for(const level of levels){
    const bands=mouthBands(level,box);let seen=0;
    for(let band=0;band<TILT_BANDS;band++){
      const plain=pieces(level,band*TILT_BAND,TILT_BAND,undefined),list=pieces(level,band*TILT_BAND,TILT_BAND,box);
      let mouth=false;
      for(const piece of list){
        if(piece.texture!==MOUTH)continue;
        mouth=true;seen++;
        // Inside the mouth picture, and from the same pixel of the portrait the square would have shown.
        assert.ok(piece.sx>=0&&piece.sy>=0&&piece.sx+piece.width<=box.width&&piece.sy+piece.height<=box.height&&piece.width>0&&piece.height>0,`${style} ${level}`);
        const under=plain.find(other=>other.x<=piece.x&&piece.x<other.x+TILT_CELL&&other.y<=piece.y&&piece.y<other.y+TILT_CELL);
        assert.deepEqual([under.sx+piece.x-under.x,under.sy+piece.y-under.y],[piece.sx+box.left,piece.sy+box.top]);
      }
      // A change of the mouth draws again only the bands mouthBands names: none with the mouth may be missing.
      if(mouth)assert.ok(bands&1<<band,`${style} level ${level} band ${band}`);
    }
    assert.ok(seen>0);
    assert.ok(bands>0&&bands<1<<TILT_BANDS);
  }
  // Upright, the mouth of the girl is in the last three bands at most, not all over the screen.
  assert.equal(mouthBands(0,MOUTH_BOXES.portrait)&0b0001111111,0);
});
test('the tilt follows the head in steps, without flickering between two',()=>{
  assert.equal(tiltLevel(0,0),0);
  assert.equal(tiltLevel(0,2),0);           // a head almost straight: upright
  assert.equal(tiltLevel(0,2.3),1);
  assert.equal(tiltLevel(1,4.4),1);         // between two steps: the one shown stays
  assert.equal(tiltLevel(1,5.3),2);
  assert.equal(tiltLevel(1,.8),1);
  assert.equal(tiltLevel(1,.6),0);
  assert.equal(tiltLevel(0,-7),-2);
  assert.equal(tiltLevel(0,40),TILT_LEVELS); // never more than 12°
  assert.equal(tiltLevel(0,-40),-TILT_LEVELS);
  assert.equal(tiltLevel(3,-12),-4);         // straight to the new side
  assert.equal(tiltLevel(2,NaN),0);
  assert.equal(tiltLevel(2,undefined),0);
});
