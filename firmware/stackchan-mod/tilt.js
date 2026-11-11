/**
 * The portrait tilted with the user's head (imitation, 10 Nov 2026). The robot's display library copies rectangles
 * and cannot turn a picture, so the tilted portrait is made of 8×8 squares, each copied from the place it has in the
 * upright picture: a real rotation, rounded to whole pixels square by square (at 12° two neighbouring squares are
 * under 2 pixels apart, a quarter of a millimetre on the screen). The picture turns around the neck (160,200), like
 * a head, in steps of 3° up to 12°; a positive tilt is clockwise for who looks at the screen. Where the turned
 * picture ends, the caller's background shows.
 * The host's drawing list holds about 200 pieces for one update of the screen (4096 bytes, 20 each: set by the
 * host's splash screen, which the face inherits) and a piece too many restarts the robot. So the picture is drawn
 * in bands of three rows of squares (120 squares, plus those cut by the border of the mouth picture), one band per
 * update, and drawTilted never asks for more than TILT_DRAWS pieces.
 */
export const TILT_CELL=8,TILT_COLUMNS=40,TILT_ROWS=30,TILT_BAND=3,TILT_BANDS=10,TILT_DEGREES=3,TILT_LEVELS=4,TILT_DRAWS=160;
// Sine and cosine of 0, 3, 6, 9 and 12 degrees, times 1024: whole numbers only.
const SIN=[0,54,107,160,213],COS=[1024,1023,1018,1011,1002],PIVOT_X=160,PIVOT_Y=200,WIDTH=320,HEIGHT=240,HALF=TILT_CELL>>1;
/**
 * The tilt to show (−4…4 steps of 3°) for a head tilted by roll degrees, given the one shown now. A new step is
 * taken only when the head is three quarters of a step away from the one shown: under about 2° the portrait stays
 * upright, and a head held between two steps does not make the picture flicker.
 */
export function tiltLevel(current,roll){
  if(!Number.isFinite(roll))return 0;
  const wanted=Math.max(-TILT_LEVELS,Math.min(TILT_LEVELS,roll/TILT_DEGREES));
  return Math.abs(wanted-current)<.75?current:Math.round(wanted);
}
/**
 * Draws rows row…row+rows−1 of the tilted picture: draw(texture,x,y,sx,sy,width,height) copies a rectangle of a
 * texture to the screen (and cuts what falls outside the texture, as the host's drawTexture does). base is the
 * 320×240 portrait; mouth, when given, is the small picture that covers box in the upright portrait.
 * Returns the number of pieces asked for; stops before TILT_DRAWS.
 */
export function drawTilted(draw,level,row,rows,base,mouth,box){
  const n=level<0?-level:level,s=level<0?-SIN[n]:SIN[n],c=COS[n],right=mouth?box.left+box.width:0,bottom=mouth?box.top+box.height:0;
  let count=0;
  for(let j=row;j<row+rows;j++){
    const v=j*TILT_CELL+HALF-PIVOT_Y,dy=j*TILT_CELL;
    for(let i=0;i<TILT_COLUMNS;i++){
      const u=i*TILT_CELL+HALF-PIVOT_X,x=PIVOT_X-HALF+((u*c+v*s+512)>>10),y=PIVOT_Y-HALF+((v*c-u*s+512)>>10);
      if(x<=-TILT_CELL||y<=-TILT_CELL||x>=WIDTH||y>=HEIGHT)continue; // beyond the picture: the background stays
      if(count+2>TILT_DRAWS)return count;
      const dx=i*TILT_CELL;
      if(mouth){
        const x0=x>box.left?x:box.left,y0=y>box.top?y:box.top,x1=x+TILT_CELL<right?x+TILT_CELL:right,y1=y+TILT_CELL<bottom?y+TILT_CELL:bottom;
        if(x0<x1&&y0<y1){
          // A square cut by the border of the mouth picture takes the portrait first, then its part of the mouth.
          if(x1-x0<TILT_CELL||y1-y0<TILT_CELL){draw(base,dx,dy,x,y,TILT_CELL,TILT_CELL);count++;}
          draw(mouth,dx+x0-x,dy+y0-y,x0-box.left,y0-box.top,x1-x0,y1-y0);count++;
          continue;
        }
      }
      draw(base,dx,dy,x,y,TILT_CELL,TILT_CELL);count++;
    }
  }
  return count;
}
// The bands (bit k for band k) where the mouth picture can show at this tilt: only those are drawn again when
// the mouth changes.
export function mouthBands(level,box){
  const n=level<0?-level:level,s=level<0?-SIN[n]:SIN[n],c=COS[n];
  let top=HEIGHT,bottom=0;
  for(let k=0;k<4;k++){
    const u=box.left+(k&1?box.width:0)-PIVOT_X,v=box.top+(k&2?box.height:0)-PIVOT_Y,y=PIVOT_Y+((u*s+v*c+512)>>10);
    if(y<top)top=y;if(y>bottom)bottom=y;
  }
  // A square shows the mouth when its centre, turned back, is within half a square of the mouth picture: at most
  // 7 pixels above or below the turned box (half a diagonal, plus the rounding).
  const first=Math.max(0,Math.ceil((top-HALF-7)/TILT_CELL)),last=Math.min(TILT_ROWS-1,Math.floor((bottom-HALF+7)/TILT_CELL));
  let bands=0;
  for(let band=Math.floor(first/TILT_BAND);band<=Math.floor(last/TILT_BAND);band++)bands|=1<<band;
  return bands;
}
