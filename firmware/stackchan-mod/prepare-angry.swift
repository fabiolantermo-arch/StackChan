// Angry faces (owner, 11 Nov 2026: «usa queste per viso arrabbiato»): the three pictures the owner sent, side by side
// in angry-source.png (2000×667: blonde girl, redhead, white robot), each cut and scaled to 320×240 so that the face
// sits where it sits in the face's other pictures (the girls: the irises at the same place and distance as in the
// sad picture; the robot: its shell the same size and centre as in white-neutral). Anything outside its own panel
// is the panel's background colour, never the next picture. Run from the repository root:
// swift firmware/stackchan-mod/prepare-angry.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let assets="firmware/stackchan-mod/assets/"
let src=CGImageSourceCreateWithURL(URL(fileURLWithPath:assets+"angry-source.png") as CFURL,nil)!,sheet=CGImageSourceCreateImageAtIndex(src,0,nil)!
guard sheet.width==2000,sheet.height==667 else{fatalError("angry-source.png is not the 2000×667 sheet")}
// panel: the picture's own rectangle in the sheet (top-left coordinates); origin: the sheet point that lands at the
// picture's top-left corner; scale: sheet pixels → 320×240 pixels; fill: background outside the panel.
func cut(_ name:String,panel:CGRect,origin:CGPoint,scale:CGFloat,fill:(CGFloat,CGFloat,CGFloat)){
  let w=320,h=240
  let ctx=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.setFillColor(red:fill.0,green:fill.1,blue:fill.2,alpha:1);ctx.fill(CGRect(x:0,y:0,width:w,height:h))
  ctx.interpolationQuality = .high
  // CoreGraphics has its origin at the bottom: flip once, then work in top-left coordinates like the rest.
  ctx.translateBy(x:0,y:CGFloat(h));ctx.scaleBy(x:1,y:-1)
  ctx.scaleBy(x:scale,y:scale);ctx.translateBy(x:-origin.x,y:-origin.y)
  ctx.clip(to:panel)
  // Drawing a picture into flipped coordinates turns it upside down: draw it flipped back inside its own frame.
  ctx.saveGState();ctx.translateBy(x:0,y:CGFloat(sheet.height));ctx.scaleBy(x:1,y:-1)
  ctx.draw(sheet,in:CGRect(x:0,y:0,width:sheet.width,height:sheet.height));ctx.restoreGState()
  let dst=CGImageDestinationCreateWithURL(URL(fileURLWithPath:assets+name) as CFURL,UTType.png.identifier as CFString,1,nil)!
  CGImageDestinationAddImage(dst,ctx.makeImage()!,nil);if !CGImageDestinationFinalize(dst){fatalError("cannot write "+name)}
}
// Blonde: irises at (262,352) and (398,352) in the sheet, at (127,127) and (200,127) in girl-sad: scale 73.3/136.
cut("girl-angry.png",panel:CGRect(x:25,y:85,width:608,height:495),origin:CGPoint(x:27,y:116.4),scale:0.539,fill:(0.05,0.07,0.30))
// Redhead: the panel (637…1237) is narrower than the eye distance alone would need, so the scale fits its width
// (0.533; the eyes come out 4% further apart than in red-sad); irises at y 353 in the sheet, 127 in red-sad.
cut("red-angry.png",panel:CGRect(x:637,y:85,width:600,height:495),origin:CGPoint(x:637,y:115.6),scale:0.533,fill:(0.07,0.15,0.30))
// White robot: shell 543×421 at (1268,103) in the sheet, 266×215 at (23,8) in white-neutral: scale 0.495, centres
// aligned. The sheet's robot sits closer to its panel's left edge: the missing columns are black, as the background;
// the panel's grey top edge and the top of the body under the head (not in the robot's other pictures) are left out.
cut("white-angry.png",panel:CGRect(x:1240,y:88,width:760,height:438),origin:CGPoint(x:1224.3,y:80.2),scale:0.495,fill:(0,0,0))
// Skin colour (owner, 11 Nov 2026: «diventa tutta rossa, deve rimanere con lo stesso colore della pelle»): the sent
// pictures are redder than the faces of Robottino. Each girl's angry picture takes the skin colour of her serene one:
// on the skin of the face (box: forehead to chin, between the cheeks) the mean and the spread of each colour channel
// are measured in both pictures, and the angry picture is moved onto the serene one's. Skin and hair take the whole
// correction, the background (blue) none, with a soft passage in between. The white robot has no skin: untouched.
func pixels(_ name:String)->[UInt8]{
  let s=CGImageSourceCreateWithURL(URL(fileURLWithPath:assets+name) as CFURL,nil)!,im=CGImageSourceCreateImageAtIndex(s,0,nil)!
  let c=CGContext(data:nil,width:320,height:240,bitsPerComponent:8,bytesPerRow:1280,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
  c.draw(im,in:CGRect(x:0,y:0,width:320,height:240));return Array(UnsafeBufferPointer(start:c.data!.assumingMemoryBound(to:UInt8.self),count:320*240*4))
}
func skinTone(_ name:String,like:String,box:(x0:Int,y0:Int,x1:Int,y1:Int),lips:(x:Double,y:Double),face:(cx:Double,cy:Double,rx:Double,ry:Double)){
  var px=pixels(name);let ref=pixels(like)
  // Skin: warm (red over green over blue) and light; eyes, brows, lips' line and background stay out of the measure.
  func skin(_ p:[UInt8],_ i:Int)->Bool{let r=Int(p[i]),g=Int(p[i+1]),b=Int(p[i+2]);return r>120&&r>g+15&&g>b+5&&r-b<150}
  func stats(_ p:[UInt8])->(m:[Double],d:[Double]){
    var sum=[0.0,0.0,0.0],sq=[0.0,0.0,0.0],n=0.0
    for y in box.y0..<box.y1{for x in box.x0..<box.x1{let i=(y*320+x)*4;if skin(p,i){n+=1;for k in 0..<3{let v=Double(p[i+k]);sum[k]+=v;sq[k]+=v*v}}}}
    let m=sum.map{$0/n};return (m,(0..<3).map{(sq[$0]/n-m[$0]*m[$0]).squareRoot()})
  }
  let a=stats(px),n=stats(ref)
  // The hair (owner, 11 Nov 2026: «quando è arrabbiata cambia il colore dei capelli»): the same, measured on the hair
  // alone, so it takes the serene hair's colour and not the skin's correction. Hair is what is neither background
  // nor inside the oval of the face (face: centre and half axes; below the chin it is neck: skin again).
  func hairAt(_ x:Int,_ y:Int)->Double{
    let dx=(Double(x)-face.cx)/face.rx,dy=(Double(y)-face.cy)/face.ry,out=max(0,min(1,((dx*dx+dy*dy).squareRoot()-1)/0.25))
    return out*max(0,min(1,(215-Double(y))/20))
  }
  func hairStats(_ p:[UInt8])->(m:[Double],d:[Double]){
    var sum=[0.0,0.0,0.0],sq=[0.0,0.0,0.0],c=0.0
    for y in 0..<240{for x in 0..<320{let i=(y*320+x)*4;if hairAt(x,y)==1&&Int(p[i])-Int(p[i+2])>30{c+=1;for k in 0..<3{let v=Double(p[i+k]);sum[k]+=v;sq[k]+=v*v}}}}
    let m=sum.map{$0/c};return (m,(0..<3).map{(sq[$0]/c-m[$0]*m[$0]).squareRoot()})
  }
  let ha=hairStats(px),hn=hairStats(ref)
  // Mean and spread alone left the blonde's hair more orange than her serene hair (same mean, other lights and
  // shadows): on the hair each channel's whole distribution is matched (the darkest tenth to the darkest tenth…).
  func histogram(_ p:[UInt8],_ k:Int)->[Double]{
    var h=[Double](repeating:0,count:256)
    for y in 0..<240{for x in 0..<320{let i=(y*320+x)*4;if hairAt(x,y)==1&&Int(p[i])-Int(p[i+2])>30{h[Int(p[i+k])]+=1}}}
    var total=0.0;for v in 0..<256{total+=h[v];h[v]=total};return h.map{$0/total}
  }
  var curve=[[Double]](repeating:[Double](repeating:0,count:256),count:3)
  for k in 0..<3{
    let from=histogram(px,k),to=histogram(ref,k);var j=0
    for v in 0..<256{while j<255&&to[j]<from[v]{j+=1};curve[k][v]=Double(j)}
    // A little smoothing: no steps where few pixels have a value.
    let raw=curve[k];for v in 0..<256{var sum=0.0,c=0.0;for d in -4...4 where v+d>=0&&v+d<256{sum+=raw[v+d];c+=1};curve[k][v]=sum/c}
  }
  for y in 0..<240{for x in 0..<320{
    let i=(y*320+x)*4,r=Double(px[i]),b=Double(px[i+2])
    let weight=max(0,min(1,(r-b+10)/40)) // 0 on the blue background, 1 on skin and hair
    let hair=hairAt(x,y)
    for k in 0..<3{
      let v=Double(px[i+k]),skinMoved=(v-a.m[k])/a.d[k]*n.d[k]+n.m[k],hairMoved=curve[k][Int(px[i+k])]
      let moved=skinMoved+(hairMoved-skinMoved)*hair
      px[i+k]=UInt8(max(0,min(255,(v+(moved-v)*weight).rounded())))
    }
  }}
  print(name,"hair",ha.m.map{Int($0)},"→",hn.m.map{Int($0)})
  // The flush on cheeks, nose and forehead: skin redder than the serene face ever is (its green/red below the serene
  // skin's 15th percentile) gets its green and blue back, most of the way. The lips keep their colour.
  var ratios:[Double]=[]
  for y in box.y0..<box.y1{for x in box.x0..<box.x1{let i=(y*320+x)*4;if skin(ref,i){ratios.append(Double(ref[i+1])/Double(ref[i]))}}}
  ratios.sort();let floor=ratios[ratios.count*15/100]
  for y in box.y0..<box.y1{for x in box.x0..<box.x1{
    let i=(y*320+x)*4;if !skin(px,i){continue}
    let dx=(Double(x)-lips.x)/34,dy=(Double(y)-lips.y)/20,away=max(0,min(1,(dx*dx+dy*dy-1)*2)) // 0 on the lips
    let r=Double(px[i]),g=Double(px[i+1]),b=Double(px[i+2]);if g/r>=floor{continue}
    let gain=1+(floor*r/g-1)*0.8*away
    px[i+1]=UInt8(max(0,min(255,(g*gain).rounded())));px[i+2]=UInt8(max(0,min(255,(b*gain).rounded())))
  }}
  let ctx=CGContext(data:&px,width:320,height:240,bitsPerComponent:8,bytesPerRow:1280,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue)!
  let dst=CGImageDestinationCreateWithURL(URL(fileURLWithPath:assets+name) as CFURL,UTType.png.identifier as CFString,1,nil)!
  CGImageDestinationAddImage(dst,ctx.makeImage()!,nil);if !CGImageDestinationFinalize(dst){fatalError("cannot write "+name)}
  print(name,"skin",a.m.map{Int($0)},"→",n.m.map{Int($0)})
}
skinTone("girl-angry.png",like:"girl-neutral.png",box:(85,40,240,225),lips:(165,192),face:(163,140,70,88))
skinTone("red-angry.png",like:"red-neutral.png",box:(100,50,225,225),lips:(164.5,192),face:(163,140,56,88))
print("Prepared girl-angry.png, red-angry.png and white-angry.png (320×240) from angry-source.png. No firmware or cloud changes.")
