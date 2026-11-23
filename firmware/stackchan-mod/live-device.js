import {Client,lowLatency} from 'robottino-socket';
import Preference from 'preference';
import Timer from 'timer';
import Time from 'time';
import AudioIn from 'embedded:io/audio/in';
import AudioOut from 'embedded:io/audio/out';
import {Container} from 'piu/MC';
import RuntimeBitmapPort from 'runtime-bitmap-port';
import config from 'mc/config';
import Bitmap from 'commodetto/Bitmap';
import {DeviceCommands,screenPixels,pcmMouthLevel,cameraChunks,jpegFrame,jpegQuality,JPEG_HEAD,JPEG_QUALITY,pictureChunks,greyChunks,windowChunks,SMALL_PIECES,CAMERA_PIECE,CallPacker,encodeCallAudio,callAudioLength,decodeCallAudio} from 'robottino-live-wire';
import {FaceLock,FRAME_WIDTH,FRAME_HEIGHT,CAMERA_FOV} from 'robottino-tracker';
import Modules from 'modules';
import {k210View} from 'robottino-k210';

// Face following. Until the iPhone has found the face: the whole 160×120 frame in grey (19.2 KB, five pieces), at
// most every 150 ms. Once it has: an 80×60 image of the part of the frame where the face must be (4.8 KB, three
// pieces; tracker.js FaceLock chooses it and puts the answers back in whole-frame coordinates), at most every
// 250 ms. Why (measured 10 Nov 2026): the robot's connection sends 5.7 KB and then waits for the network, 130-190 ms
// on the hotspot, so the whole frame takes about a second and the head got one answer a second; the small image
// leaves in one go, and is taken when the connection has room for all of it (SMALL_ROOM; after 600 ms anyway).
// Measured on the robot with the small image (10 Nov 2026): a frame every 0.6 s, and the answer is back 0.6-0.8 s
// after the frame was taken (0.3 s to take, convert and write it, the rest is network: the iPhone answers one frame
// at a time and looks at the next only once the robot has confirmed its answer, about half a second on the
// hotspot), so about one answer a second. Taking the next frame as soon as there was room for its first piece was
// tried: 2.0 frames a second instead of 1.7 and no more answers than chance gives, because the camera had no new
// image yet (it needs about 0.2 s after the last one goes back) and its capture then held the whole robot for up to
// 0.23 s. With the head moving nothing changes anyway: the frame waits for the head to be still.
// A frame starts only once the previous one has left: a slow network gets fewer frames, never a queue. The head
// pose and the window of the last 8 frames are kept, so a late answer from the iPhone still says where the face
// was (tracker.js aim).
// During a conversation (face following with the iPhone open, 9 Nov 2026) the frames are at least 250 ms apart
// and, while the robot listens, never whole: the voice comes first for memory, processor and network.
// A piece is written only when nothing waits in the socket (SEND_BACKLOG 0). WebSocket.js keeps unsent data in the
// robot's fixed JavaScript memory (9 Nov 2026: a whole 320×240 frame queued at once restarted the robot), and the
// answers to the iPhone's commands queue behind it: the relay closes everything when an answer takes over 1.5 s,
// which happened on the hotspot (about 20 KB/s) with 16 KB of pieces ahead, and each forced close was followed by
// a restart of the robot. Now an answer waits behind one 4 KB piece at most.
const SEND_BACKLOG=0,VIDEO_FRAME_MS=333,PUMP_MS=25;
// The video as JPEG pictures (14 Nov 2026, live-wire.js kind 8; the host makes them, video-jpeg.c). A picture is
// about 5 KB instead of 38: it is taken when the connection has room for all of it (JPEG_ROOM of its 11.4 KB; after
// JPEG_ROOM_WAIT_MS anyway, so a slow network gets fewer pictures and never a queue), made and written in the same
// turn. At most one every VIDEO_JPEG_MS; during a call one every VIDEO_JPEG_CALL_MS, so the sound keeps its share of
// the link (8 KB a second each way out of about 35).
const VIDEO_JPEG_MS=100,VIDEO_JPEG_CALL_MS=250,JPEG_ROOM=8000,JPEG_ROOM_WAIT_MS=600;
// The video sent from the frames of following alone (the iPhone's hand gestures): one frame every SELF_VIDEO_MS at most.
const SELF_VIDEO_MS=100; // 150 until the evening of 15 Nov 2026 (owner: «cerca di massimizzare la velocità di inseguimento»)
// The iPhone helps following (owner, 15 Nov 2026: «possiamo migliorare l'inseguimento con iPhone?»): it gets the frames
// of following as video, finds the face with Apple's detector (which sees it from below, with glasses, against the
// light, where the robot's own often does not) and answers where it is in that frame (the `track` command, as for
// «Segui il mio viso»). The robot believes it only while its own detector has not seen the face for SELF_HELP_AFTER_MS:
// its own answers are newer. For this the video also goes out in a conversation, but slowly and only while the robot
// listens (SELF_VIDEO_TALK_MS; TO BE CONFIRMED that the voice stays smooth: raise it, or stop it, if it does not).
const SELF_HELP_AFTER_MS=500,SELF_VIDEO_TALK_MS=600,SELF_VIDEO_POSES=8;
// First try on the robot (15 Nov 2026, 22:36; owner: «non cambia»). The log: sitting in front of the robot, its own
// detector did not find the owner once in 25 s and the iPhone's answers kept the head on him (help=30); but when he
// moved out of the picture nobody saw him, the robot waited its 5 s and made its nine stops in 25 s, as without the
// iPhone. So, while the iPhone is looking (it answered in the last SELF_HELPER_MS): when it too has seen nothing in
// SELF_HELP_MISSES frames, the face has really gone (the 5 s were for the robot's own detector, which misses a still
// face for a second or two): the look around starts after SELF_LOST_HELPED_MS and each stop lasts
// SELF_SEARCH_HELPED_MS, enough for the iPhone to answer about the first frame taken there; and the frames do not go
// to the robot's slower detector (0.8 s each, during which no frame is taken for anyone).
// Third try (22:55, owner: «ancora male»), read on the card: 13-20 frames in 5 s, and only 6-7 when the robot's slower
// detector worked (0.8 s a frame, no frame for anyone meanwhile; when it is the one that finds the face it keeps every
// frame); the iPhone's answer 300-460 ms after its frame; so about one correction a second, and the head always
// pointing where a walking owner had been a second before. Two things, each with its own switch:
//  - SELF_HELP_NO_DEEP_MS: while the iPhone has seen the face in the last 2 s, no frame goes to the slower detector
//    (the iPhone finds what it finds, sooner). It comes back by itself when the iPhone stops seeing the face.
//  - SELF_LEAD: the head aims ahead of a face that moves steadily. From two sightings in a row (the robot's own or the
//    iPhone's) the face's speed across the room; when it is at least SELF_LEAD_MIN and goes the same way as before, the
//    head aims where the face will be when the next frame is taken: the age of the sighting plus SELF_LEAD_S, never
//    more than SELF_LEAD_MAX ahead. A face that stops, or turns back, gets no lead at the very next sighting.
//    IF THE HEAD OVERSHOOTS OR SWINGS, THIS IS THE FIRST THING TO SWITCH OFF (SELF_LEAD false).
const SELF_HELP_NO_DEEP_MS=2000,SELF_LEAD=true,SELF_LEAD_S=.35,SELF_LEAD_MIN=.14,SELF_LEAD_MAX=.3,SELF_LEAD_MAX_UP=.15,SELF_LEAD_GAP=[150,1500];
// TRIED ON THE ROBOT AND SWITCHED OFF THE SAME EVENING (22:45-22:50, owner: «no, mi perde in continuazione, è
// peggiorato»): SELF_HELPED_QUICK false. The iPhone's answers come a few tenths of a second after their frame and
// not for every frame (one at a time, five a second at most, none while the head moves), so «three frames without an
// answer» and «1.5 s without a sighting» happened all the time with the owner sitting there, and the head went
// looking and lost him; and without the slower detector the robot's own best eye for him was shut. NOT TO BE
// SWITCHED ON AGAIN AS IT IS: a sooner search needs the iPhone to say «I looked at this frame and saw nobody», which
// it does not say today.
const SELF_HELPED_QUICK=false,SELF_HELPER_MS=60000,SELF_HELP_MISSES=3,SELF_LOST_HELPED_MS=1500,SELF_SEARCH_HELPED_MS=1000;
// Live call (live-wire.js, 10 Nov 2026): 8 kHz µ-law, a piece of 800 bytes every tenth of a second, 8 KB a second
// each way. With 16 kHz PCM16 (32 KB a second each way, in 640-byte pieces) the robot took in 8-25 KB a second and
// got 40-63% of its own microphone out: its link carries 30-35 KB a second in all.
// A piece from the microphone is dropped while more than two wait to be handed to the connection: by then the
// connection itself holds over a second of sound that the network has not taken. Before (9 Nov 2026) audio piled up
// in the fixed JavaScript memory until the robot restarted.
// With the camera on (a call while the robot follows a face, or with the video) a piece of image larger than the
// room left in the connection leaves in two parts, and its rest waits here: up to 4.1 KB that are image, not sound
// held up. So the limit is one piece of image higher, still two pieces of sound: with the limit of the call alone
// the microphone lost a piece every time an image was leaving. The image never waits behind sound (SEND_BACKLOG).
const CALL_BACKLOG=1600,CALL_CAMERA_BACKLOG=CALL_BACKLOG+CAMERA_PIECE+32;
// Sound from the iPhone waiting for the speaker: 0.4 s at most (16 kHz PCM16), then new pieces are dropped. Pieces
// are a tenth of a second and the hotspot delivers them in groups.
const CALL_PLAY_QUEUE=12800;
// The link ends when nothing has come from the server for this long. The robot sends a ping every 5 s and the
// server answers each one, so silence means that the way from the server is blocked (10 Nov 2026: with the
// iPhone's audio queued on that way the robot learnt that the app had gone about 70 s later, and kept its
// microphone open meanwhile; once nothing at all came for a minute). A new link is then made as after any close.
const LINK_SILENCE_MS=12000;
// What the call's speaker plays when nothing has come from the iPhone: one block for the whole program, so that
// silence makes no new memory 60 times a second.
const SILENCE=new Uint8Array(512);
// The host is busy for about a second while it starts or stops the camera (it also switches the touch panel off and
// on): a servo reply read that late looked lost and the 1.2 s check blocked the motions (9 Nov 2026, at the end of
// a conversation). So the camera first waits for the servos' confirmation (up to 1.5 s), and while it switches no
// head command starts (mod.js asks busy()). Shared by every link: an old link may still be stopping its camera.
const CAMERA_WAIT_MS=1500;let cameraSwitching=0;
// Following takes a frame only with the head still (mod.js headMoving: moving, then 150 ms to settle): a frame
// taken while the head turned at 3 rad/s was blurred and its pose up to 15° wrong. After 1 s without a frame, one
// is taken anyway.
// One camera size for following and video (9 Nov 2026): when the size changed, the host closed and rebuilt the
// camera and its camera task read freed memory (Guru Meditation in cameraLoop, camera.c), restarting the robot.
// 160×120 also suits the hotspot better: a colour frame is 38 KB instead of 153 KB.
const TRACK_SIZE={width:160,height:120},VIDEO_SIZE=TRACK_SIZE,TRACK_FRAME_MS=150,TRACK_VOICE_FRAME_MS=250,TRACK_POSES=8,TRACK_STILL_WAIT_MS=1000;
// Three pieces of the small image as the connection counts them (1620 bytes each plus about 37 of framing).
const TRACK_SMALL_FRAME_MS=250,SMALL_ROOM=5000,SMALL_ROOM_WAIT_MS=600;
// Following by the robot alone (13 Nov 2026, owner: «tramite il robottino, non iPhone… il più veloce possibile»): the
// host finds the face itself (firmware/host/face, module robottino-face-finder), so no picture leaves the robot and
// nothing waits for the network. Camera mode 'self': every frame the camera gives is searched, around where the face
// was (a few ms) or everywhere when it is not known (tens of ms), and the head is aimed at once. Nothing is stored and
// nobody is recognized: only where a face is.
// - SELF_SCORE: the summed confidence a face needs when it is looked for everywhere, SELF_NEAR_SCORE around where it
//   was. Both can be set on the robot (preferences selfScore, selfNearScore) while the right values are being found.
// - The place of the face is kept as a direction (head pose of the frame + place in the image), so the next search
//   looks where the face must be after the head has turned. Forgotten after SELF_MEMORY_MS without seeing it.
// - While Robottino talks a frame at most every SELF_SPEAK_MS: the voice comes first.
// - With the head turning the picture is blurred and the pose of the frame less sure: SELF_MOVING_GAIN of the way.
// - Looking for a face (owner, 13 Nov 2026: «quando non mi trova deve fare dei piccoli movimenti a destra, a sinistra,
//   in alto e in basso. Sempre intorno all'ultima posizione dove mi ha visto»): after SELF_SEARCH_MS with no face the
//   head makes one small move from home (SELF_AROUND, radians: 12° to each side, 10° up and down, home; then 24° to
//   each side, 20° up, 12° down, home), then rests (SELF_REST_MS in a conversation, SELF_IDLE_REST_MS otherwise:
//   nobody may be there) and starts again. Home is where a face was last seen for sure (both networks), for
//   SELF_HOME_MS; before any face, straight ahead and SELF_REST_UP up, where a person sitting at the desk is. The
//   first tries were steps of half a picture from wherever the head was: only the owner's chin was in the first
//   picture, then the head «guarda in alto», then «sta puntando sempre in alto e non mi trova».
// - SELF_GAIN: how much of the way to the face the head goes at each answer. 0.9 since 14 Nov 2026 (0.8 before): the
//   frames are now taken with the head really still, so one move is enough and the little that is left stays inside
//   the 3° the head ignores (tracker.js AIM_DEADBAND); owner: «funziona ma è lento».
const SELF_SCORE=6,SELF_NEAR_SCORE=3,SELF_MEMORY_MS=1200,SELF_SPEAK_MS=120,SELF_GAIN=.9,SELF_MOVING_GAIN=.5;
// - With the neural detector (face-dl.cpp) every frame is searched whole, in the detector's own task; a face counts
//   from SELF_NEURAL_SCORE (0…1; the detector itself gives nothing under 0.5); an answer that does not come within
//   SELF_NEURAL_MS is given up.
// - SELF_NET: the size the detector's first network works at. On the robot its own 160×120 took 216-235 ms a picture
//   (13 Nov 2026: its working memory is in the slow external RAM, the internal one has 44 KB free); the work goes with
//   the number of pixels. At 96×72: 55-70 ms and the owner's face found in every frame, sitting at the desk; at 80×60:
//   40-50 ms but, with the owner in front of the robot, the face found in 6-9 frames of 33-35 and lost again and again.
const SELF_NEURAL_SCORE=.5,SELF_NEURAL_MS=3000,SELF_NET=[96,72],SELF_QUICK_MS=700,SELF_SURE_MS=2000,SELF_POLL_MS=8;
// While Robottino talks the detector is asked less often: its work in the external RAM slows JavaScript down too
// (13 Nov 2026: turns of the main loop up to 0.27 s late while it ran without a pause), and the voice comes first.
const SELF_NEURAL_SPEAK_MS=300;
// In a conversation the voice comes first (13 Nov 2026, first conversation with the neural detector at full pace:
// the speaker ran dry for up to 1.6 s, the turns of the main loop came 0.4-0.7 s late, the internal RAM went down to
// 0 KB; owner: «non mi segue e la voce va a scatti, adesso si è anche fermata»). The detector and the program share
// the slow external RAM. So during a conversation: no frame at all while Robottino talks, one every SELF_TALK_MS while
// it listens, always at the quick size (never the slow full one), and the look around goes slowly (a step every
// SELF_TALK_SEARCH_MS). Second conversation, with no look around at all: the head had been put straight up when the
// conversation opened and the face was never found again («non mi sta seguendo»).
// 14 Nov 2026: with twice the internal RAM (the Bluetooth session nobody used is off: 100 KB free instead of 48) and
// the external RAM at 80 MHz, a conversation went with 77-88 KB free and the speaker never dry; but the owner, with one
// frame every half second and none during a reply of 30 s: «non mi sta seguendo». So in a conversation: a frame every
// SELF_TALK_MS while the robot listens and every SELF_TALK_SPEAK_MS while it talks (the microphone is closed then, so
// the servos' noise reaches nobody). The look around stays slow. If the voice stutters again, these go back up first.
// 14 Nov 2026, 20:01 (owner: «la voce sta andando un po' a scatti»; Wi-Fi at −80…−86 dBm, internal RAM down to 19 KB):
// SELF_TALK_SPEAK_MS 800 (was 400), as written above: the first number to raise.
const SELF_TALK_MS=250,SELF_TALK_SPEAK_MS=800,SELF_TALK_SEARCH_MS=2500;
// 14 Nov 2026, 19:05 (owner: «inseguimento non va, si gira dalla parte opposta»): in a conversation only the quick pair
// works, and it loses the owner seen from below after a few seconds; the look around then took the head to ±78°,
// away from the person who was talking to it. In a conversation a face seen in the last SELF_TALK_HOLD_MS is still
// there: the head stays where it saw it; the look around starts only after that (nobody seen for a while).
const SELF_TALK_HOLD_MS=20000;
// - A face that was being followed and is no longer seen (owner, 13 Nov 2026: «ogni tanto mi perde e guarda in
//   alto»): the head stays where it is for SELF_LOST_MS (a turned head, a hand, a blurred frame: the face comes back
//   by itself), and only then makes its small moves.
// - A face that left the picture by an edge (owner, 13 Nov 2026: «se mi alzo in su si perde ogni tanto»): when it was
//   last seen away from the middle (SELF_EDGE of the picture from an edge) the head goes that way after SELF_GONE_MS,
//   without the 3 s wait, one step of half a picture (SELF_GONE_STEPS); if the face is not there, the small moves
//   around home.
// - A far face is small: at 96×72 the detector does not see it (standing up, a metre and more away). So the detector
//   works at its own 160×120 (0,0: slow, 230 ms) while no face is found for SELF_FAR_AFTER_MS and for a face smaller
//   than SELF_FAR_SIZE pixels, and goes back to SELF_NET for a face of SELF_NEAR_SIZE and more.
const SELF_SEARCH_MS=1600,SELF_REST_MS=6000,SELF_IDLE_REST_MS=20000,SELF_HOME_MS=600000,SELF_REST_UP=.44;
// 14 Nov 2026 (owner: «se vado troppo in alto mi perde», standing up from the desk): the moves go up first and higher
// (12°, 25°, then up and 12° to each side), where someone who has just stood up is; then the sides, down, home.
// The same day, 09:55 (owner: «mi ha seguito una volta in alto e poi di nuovo sceso»): the second move reached 49° up, did
// not find the standing owner in the half second it stayed, and the moves went on down and to the sides. Three moves
// up now (12°, 25°, 38°: the pictures taken with the owner standing show the face about 20° above where it is when
// sitting, more when standing closer), the two highest again with 12° to each side, and each move is given SELF_SEARCH_MS
// of 1.3 s instead of 0.9: after the third of a second the head takes to arrive, about ten pictures instead of five.
// 10:13 (owner: «mi sono risieduto ed è rimasto con la testa in alto»): once the head had followed him standing, that
// was the place the moves went around, and they only went higher. From a high place (above SELF_HIGH, about 35°: a
// standing person) the same moves go the other way, down first, to where a sitting person is; and the last two are
// 12° and 25° to the other side of where the first ones went.
// 11:02 (owner: «se vado a destra mi sta cercando ancora in alto»): the moves began upwards whatever the face had been
// doing. Each frame is taken with the head still after a move, so where the face is in it, off the middle, is which
// way it has gone since: that is kept (selfDrift, half of the new, half of the old), and the moves begin that way.
// To a side (SELF_DRIFT of the picture and more): 12°, 24° and 36° to that side first, then the upright ones, then the
// other side. Up or down: that way first; with neither, down from a high place and up otherwise, as before.
// 14 Nov 2026, 19:25 (owner: «l'inseguimento no, mi si continua a girare in alto»; on the card: the owner sitting still,
// found at 45 and 55 for minutes, the last frames at 43 and 34, and the round began 52° up): a tenth of the picture is the
// detector's own jitter, not a way. A way counts from about an eighth of the picture off the middle, kept over a few frames
// (SELF_DRIFT .12, was .05); with no way, the round stays at the height the head is at first (SELF_SCAN_HEIGHT 3: a change of height
// costs as much as three steps to the side; was 1.6, and «no way» went to the other height first). 19:52 (owner,
// face covered for ten seconds: «si è girato a sinistra e poi in alto»: the third stop went up): SELF_SCAN_HEIGHT 6,
// the whole of the height the head is at, both sides, before the other height.
const SELF_HIGH=.62,SELF_DRIFT=.12;
// 11:10 (owner: «usa uno schema di movimento ottimizzato quando mi perde, uno zigzag o qualcosa che calcoli tu,
// ottimizzato per fare minori movimenti possibili e maggiore spazio controllato»). The small moves around the last
// place are gone: the head now looks at the whole space it can reach, in as few stops as cover it. The camera sees
// 58° by 45° and a face must be whole in the picture, so the stops are 39° apart sideways (19° of two pictures in
// common) and 30° apart in height (15° in common): five to the sides (0, ±39°, ±78°) at two heights (22° up, where a
// sitting person is, and 52° up, where a standing one is): ten stops for 214° by 75°. They are taken as a zigzag:
// from where the head is to the nearest stop not yet seen, a change of height counting more than a step to the side,
// so that one height is followed to its end and the other on the way back. The first move goes the way the face was
// going when it was lost (selfDrift); with no way known, to the other height first (someone who stood up or sat
// down). The stop the head is at already comes last, then the place of rest.
const SELF_SCAN_YAW=[-1.36,-.68,0,.68,1.36],SELF_SCAN_PITCH=[-.38,-.9],SELF_SCAN_HEIGHT=6,SELF_SCAN_NEAR=.25;
// With the K210 leading (23 Nov 2026, owner: «quando mi perde va a cercarmi troppo lontano»: the round went to 78° and
// 52° up): its field is wider than the robot camera's (about 68° across, not 58°), so three stops at the height of rest
// see ±73° around the front.
const SELF_K210_YAW=[-.68,0,.68],SELF_K210_PITCH=[-.38];
const selfScan=(pose,driftX,driftY,k210=false)=>{
  const start=[pose?.y??0,pose?.p??-SELF_REST_UP],cells=[],last=[];
  for(const pitch of k210?SELF_K210_PITCH:SELF_SCAN_PITCH)for(const yaw of k210?SELF_K210_YAW:SELF_SCAN_YAW){const cell=[yaw,pitch];(Math.hypot(yaw-start[0],pitch-start[1])<SELF_SCAN_NEAR?last:cells).push(cell);}
  const side=driftX<-SELF_DRIFT?1:driftX>SELF_DRIFT?-1:0; // left in the picture is a higher yaw (tracker.js aim)
  // Up is a lower pitch. From a high place (a standing person) with no way known: down first, where a sitting one is
  // (owner, 10:13: «mi sono risieduto ed è rimasto con la testa in alto»); from a low one, the same height first.
  const way=driftY<-SELF_DRIFT?-1:driftY>SELF_DRIFT?1:side?0:start[1]<-SELF_HIGH?1:0;
  const plan=[];let at=start;
  while(cells.length){
    let best=0,least=Infinity;
    for(let i=0;i<cells.length;i++){
      const dy=cells[i][0]-at[0],dp=cells[i][1]-at[1];let cost=Math.hypot(dy,dp*SELF_SCAN_HEIGHT);
      // The first stop goes the way known (side, height): any stop the other way is left for later.
      if(!plan.length){if(side&&!(dy*side>.1))cost+=50;if(way&&!(dp*way>.1))cost+=50;}
      if(cost<least){least=cost;best=i;}
    }
    at=cells.splice(best,1)[0];plan.push(at);
  }
  plan.push(...last);
  // The round always ends at the place of rest, in front (15 Nov 2026, on the card: a round that began with the head
  // at −90° ended at the stop next to it, and the head stayed turned 78° away for 15 s with the owner sitting in
  // front of the robot; it found him as soon as it went back to rest). Until then the place of rest was added only
  // when the round had not begun at a stop.
  const end=plan.at(-1)??start;
  if(Math.hypot(end[0],end[1]+SELF_REST_UP)>=SELF_SCAN_NEAR)plan.push([0,-SELF_REST_UP]);
  return plan;
};
// Third try on the robot with the quick search (first network only), the full size for far faces and the step after
// a face that left by an edge all on (13 Nov 2026, 23:00): the face found in 8-9 frames of 20-27 instead of 20 of 20,
// and the owner: «è peggiorato, sembra che vada a caso e non mi segue più». A place the first network gives is not
// always a face, the full size takes 0.26 s a frame, and a step of half a picture after one missed frame throws the
// face out. They stay in the code, switched off (SELF_QUICK, SELF_FAR, SELF_GONE_STEPS 0): every frame is searched
// with both networks at 96×72, the head follows what they find, and when they find nothing it waits and then makes
// its small moves around where the face was.
// 14 Nov 2026: the full size for far faces is on again (owner, standing up in front of the robot: «non mi segue bene»;
// the trail showed the face gone from the middle of the picture and not found again for half a minute, with the head
// pointing where a standing person is: a metre away a face is about 13 points wide at 96×72, under what the detector
// sees). After SELF_FAR_AFTER_MS with no face the detector works at its own 160×120, and stays there for a small face.
// ...and off again two hours later: with it, the step after a lost face and the gentler moves all on, the owner said
// «non funziona» three times running, and the last trail showed the head sent to 81° up and 58° to one side by two
// steps taken on single sightings at the full size. Back to what followed the owner well at 08:39 (the measured wait
// and nothing else); a standing person is looked for by the small moves, which now go up first (SELF_AROUND).
// 14 Nov 2026, 10:00: on once more, and now it means another detector, not another size. The owner stood still in
// front of the robot for twenty seconds while the head made all its moves, with ten pictures and more at each: the
// quick pair of networks did not find him once (seen from below, his face is not a face for it). So after
// SELF_FAR_AFTER_MS with no face the pictures go to the host's other detector (ESPDet, startNeural mode 2: slower, and
// better by Espressif's own numbers), and stay with it for a face it finds smaller than SELF_NEAR_SIZE. The quick pair
// is back for a near face and for the whole of a conversation (the voice comes first). With a host that has no such
// detector nothing changes (the host takes mode 2 for the usual search).
// First try on the robot (10:08, owner standing: «ora è salito»): the other detector found him, the head went up and
// stayed on him; but each time it had found him the frames went back to the quick pair, which does not see him, for
// 1.2 s before the other was asked again: one place every two seconds. Now the detector that finds the face keeps the
// frames: the quick pair is tried again with one frame every SELF_DEEP_PROBE_MS, and takes over when it finds him.
// While nobody is found the slower detector takes one frame every SELF_DEEP_EVERY_MS and the quick pair the others
// (10:13: with every frame given to the slower one, 0.7 s each, the owner sitting down again in front of the robot
// would have been seen only by it).
const SELF_QUICK=false,SELF_FAR=true,SELF_DEEP_PROBE_MS=4000,SELF_DEEP_EVERY_MS=1500;
// 5 s (was 2, 14 Nov 2026, 19:25): on the card the owner sitting still is missed for one or two seconds again and
// again, and found again by itself.
const SELF_LOST_MS=5000;
// 14 Nov 2026: the step after a face that left by an edge is on again, two steps at most (owner, with the frames now
// taken only with the head really still and the face found in every one of them: «se vado troppo in alto mi perde»;
// the trail showed the face at the top of the picture, then nothing, and the small moves around go up 20° at most,
// nine seconds later). A face last seen in the outer SELF_EDGE of the picture and not found for SELF_GONE_MS: the head
// goes half a picture that way, and once more if it is still not there; then the usual wait and the small moves.
// The same morning (owner, standing up and walking to one side: «non mi segue», «mi alzo e vado a sinistra e lui si gira
// a destra»): the face was lost while it rose, last seen above the middle of the picture but not yet in its outer 30%,
// so no step followed it, and the small moves around the old place never looked where a standing person is. Now the
// step follows a face last seen anywhere off the middle (SELF_EDGE 0.4: outside the central fifth of the picture, on
// either axis or both: upwards and to the side together). A face that is being followed while it stays still sits in
// that central fifth, so a face that only turns away sets nothing off.
// Off again (SELF_GONE_STEPS 0) at 09:15 of the same morning, see SELF_FAR above.
const SELF_EDGE=.4,SELF_GONE_MS=500,SELF_GONE_STEPS=0,SELF_FAR_AFTER_MS=1200,SELF_FAR_SIZE=40,SELF_NEAR_SIZE=52;
export function createLiveDevice(robot,hooks){
  const lock=new FaceLock();
  let finder;try{if(Modules.has('robottino-face-finder'))finder=Modules.importNow('robottino-face-finder');}catch{finder=undefined;}
  const number=(key,fallback)=>{try{const value=Preference.get('robottino',key);return typeof value==='number'&&Number.isFinite(value)&&value>0?value:fallback;}catch{return fallback;}};
  // NOT GOOD ENOUGH YET (13 Nov 2026, tried on the robot): this finder (pico) found every test portrait on the Mac and
  // not once the owner's real face in the camera's own pictures (seen from below, with glasses, the ceiling light
  // behind: 0 windows, 5 with the picture enlarged three times). So following alone is off unless it is switched on
  // on the robot (preference selfFollow true), and the iPhone's «Segui il mio viso» works through the iPhone as before.
  // With the neural detector of the host (face-dl.cpp, esp-dl: made for real faces) following alone is on unless it
  // is switched off on the robot (preference selfFollow false).
  let neural=false;try{neural=finder?.neural?.()===true;}catch{neural=false;}
  const selfOn=()=>{try{const set=Preference.get('robottino','selfFollow');return neural?set!==false:set===true;}catch{return neural;}};
  let selfWanted=false,selfFace,selfStats,selfStep=0,selfWaitFrom,selfSeenAt,selfLast,selfGone=0,selfFar=false,selfHome,selfMissFrom;
  // For how long nobody has been seen (mod.js: after 30 s the robot stops and closes its eyes): since the last frame
  // with a face, or since the camera began to look if none has had one.
  let selfFoundAt,selfLookFrom,selfMarked=0,selfProbeAt,selfDeepAt,selfDriftX=0,selfDriftY=0,selfPlan,selfBodyStep;
  // The size the detector works at: its own for far (small) faces, SELF_NET otherwise.
  // far: the slow detector that finds more (startNeural mode 2) instead of the quick pair. The pair always works at SELF_NET.
  const netSize=wanted=>{selfFar=SELF_FAR&&wanted&&!hooks.conversation?.();};
  // TEMPORARY (K151 bring-up): how fast following alone really goes, on the USB log every 5 s (frames searched, how
  // many everywhere, faces found, the average and the longest search in ms, windows tried by the last one).
  // The trail (13 Nov 2026, «l'inseguimento mi sembra peggiorato»): where each frame showed the face, two digits a
  // frame (tenths of the picture from the left and from the top, 55 = the middle; `..` = no face), and where the
  // head is at the end, in degrees. A face that swings from side to side or runs out by an edge shows here.
  const selfTrail=new Uint8Array(64),selfMarks=new Uint8Array(64); // selfMarks: the move of the look around made just before that frame (1…)
  const selfStat=(found,everywhere,ms,place=255)=>{
    if(typeof trace!=='function')return;
    const s=selfStats??={frames:0,wide:0,found:0,sum:0,most:0,at:Time.ticks};
    if(s.frames<selfTrail.length){selfTrail[s.frames]=place;selfMarks[s.frames]=selfMarked;selfMarked=0;}
    s.frames++;if(everywhere)s.wide++;if(found)s.found++;s.sum+=ms;if(ms>s.most)s.most=ms;
    if(Time.delta(s.at)<5000)return;
    trace(`[robottino] self frames=${s.frames} wide=${s.wide} found=${s.found}${s.deep?' deep='+s.deep:''}${selfHelped?' help='+selfHelped+(selfHelpCount?' in '+Math.round(selfHelpMs/selfHelpCount)+' ms':''):''}${selfLeads?' lead='+selfLeads:''} ms=${Math.round(s.sum/s.frames)}/${s.most} ${neural?'net='+finder.neuralMs()+' '+(finder.neuralInfo?.()??''):'tested='+finder.tested()} in ${Time.delta(s.at)} ms\n`);
    // A move of the look around shows as «>» and its letter (a = the first) before the first frame taken after it.
    let trail='';for(let i=0,n=Math.min(s.frames,selfTrail.length);i<n;i++){const v=selfTrail[i],m=selfMarks[i];if(m)trail+='>'+String.fromCharCode(96+m);trail+=v>99?'..':(v<10?'0':'')+v;}
    const head=hooks.headPose?.();
    trace(`[robottino] self trail ${trail} head=${head?Math.round(head.y*57.3)+','+Math.round(head.p*57.3):'-'}\n`);
    selfStats=undefined;selfHelpMs=0;selfHelpCount=0;
  };
  // What a frame showed: a face (centre and side in pixels) or none. The head aims at the face (mod.js aim), or takes
  // the next step of the look around. near: the face was looked for only around where it had been.
  const selfAnswer=(face,width,height,pose,moving,near,spent,deep=false)=>{
    selfStat(!!face,!near,spent,face?Math.min(9,Math.floor(face.x*10/width))*10+Math.min(9,Math.floor(face.y*10/height)):255);
    if(!face){
      if(near&&!moving)selfFace=undefined; // not where it was: everywhere next time
      if(near||moving||!pose)return;
      selfWaitFrom??=Time.ticks;
      selfMissFrom??=Time.ticks;
      if(neural&&Time.delta(selfMissFrom)>=SELF_FAR_AFTER_MS){netSize(true);selfProbeAt=undefined;} // it may be far: also a face never seen yet
      // It went out by an edge: after it, that way.
      if(selfLast&&selfGone<SELF_GONE_STEPS&&Time.delta(selfWaitFrom)>=SELF_GONE_MS){
        const {x,y}=selfLast,sx=x<SELF_EDGE?0:x>1-SELF_EDGE?1:.5,sy=y<SELF_EDGE?0:y>1-SELF_EDGE?1:.5;
        if(sx!==.5||sy!==.5){
          if(hooks.aim({x:sx,y:sy,pose,gain:1})){selfGone++;selfWaitFrom=undefined;selfSeenAt=Time.ticks;if(typeof trace==='function')trace(`[robottino] self after ${sx},${sy}\n`);}
          return;
        }
        selfLast=undefined;
      }
      // No face anywhere: small moves around home, one at a time, once the head has been still on this view long enough.
      const talk=neural&&!!hooks.conversation?.(),helper=helperOn(),pace=talk?SELF_TALK_SEARCH_MS:helper?SELF_SEARCH_HELPED_MS:SELF_SEARCH_MS;
      // Just lost: it may come back. With the iPhone looking too, and blind as well for a few frames, it has gone.
      if(selfStep===0&&selfSeenAt!==undefined&&Time.delta(selfSeenAt)<(helper&&selfUnseen>=SELF_HELP_MISSES?SELF_LOST_HELPED_MS:SELF_LOST_MS))return;
      if(hooks.conversation?.()&&selfFoundAt!==undefined&&Time.delta(selfFoundAt)<SELF_TALK_HOLD_MS)return; // talking to it: still there
      // The rover is looking for the face with the whole body (mod.js bodySearch, rover-follow.js; owner, 15 Nov 2026: «se
      // non mi vede il rover deve girarsi finché non mi vede»): the head does not look around, it stays where it is and
      // the turning body carries its view on from there (someone who walked round the robot is at the same height).
      // After each turn the first frame goes to the slower detector, as at each stop of the head's own look around.
      const body=hooks.bodySearch?.();
      if(typeof body==='number'){
        if(body!==selfBodyStep){selfBodyStep=body;selfDeepAt=undefined;}
        selfStep=0;selfPlan=undefined;selfWaitFrom=undefined;
        return;
      }
      selfBodyStep=undefined;
      if(Time.delta(selfWaitFrom)<(selfPlan&&selfStep>=selfPlan.length?(hooks.conversation?.()?SELF_REST_MS:SELF_IDLE_REST_MS):pace))return;
      // The stops of this round, chosen when it begins (selfScan).
      if(!selfPlan||selfStep>=selfPlan.length||selfStep===0){selfStep=0;selfPlan=selfScan(pose,selfDriftX,selfDriftY,!!hooks.k210?.());}
      const [toYaw,toPitch]=selfPlan[selfStep];
      // At each stop the first frame goes to the slower detector, which finds more, the others to the quick pair.
      if(hooks.look?.({y:toYaw,p:toPitch})){selfStep++;selfMarked=selfStep;selfWaitFrom=undefined;selfDeepAt=undefined;if(typeof trace==='function')trace(`[robottino] self search ${selfStep}\n`);}
      return;
    }
    selfStep=0;selfWaitFrom=undefined;selfSeenAt=selfFoundAt=selfOwnAt=Time.ticks;selfGone=0;selfMissFrom=undefined;selfBodyStep=undefined;selfUnseen=0;
    const x=face.x/width,y=face.y/height;selfLast={x,y};selfDriftX=selfDriftX*.5+(x-.5)*.5;selfDriftY=selfDriftY*.5+(y-.5)*.5;
    // The detector that found the face keeps the frames (the quick pair is tried again now and then: neuralStart).
    if(neural){if(deep){netSize(true);selfProbeAt??=Time.ticks;}else{netSize(false);selfProbeAt=undefined;}}
    if(pose)selfFace={yaw:pose.y+(.5-x)*CAMERA_FOV.x,pitch:pose.p-(.5-y)*CAMERA_FOV.y,size:face.size,at:Time.ticks};
    if(pose&&!near)selfHome={yaw:selfFace.yaw,pitch:selfFace.pitch,at:Time.ticks};
    if(pose){const to=moving?{x,y}:selfAhead(x,y,pose,spent);hooks.aim({x:to.x,y:to.y,pose,gain:moving?SELF_MOVING_GAIN:SELF_GAIN});}
  };
  // One frame for the cascade (pico): searched here and now, around where the face was when that is known.
  const selfFrame=(frame,pose,moving)=>{
    const width=frame.width,height=frame.height,now=Time.ticks;
    if(selfFace&&Time.delta(selfFace.at)>=SELF_MEMORY_MS)selfFace=undefined;
    let hx=0,hy=0,hs=0;
    if(selfFace&&pose){
      const x=Math.round((.5-(selfFace.yaw-pose.y)/CAMERA_FOV.x)*width),y=Math.round((.5+(selfFace.pitch-pose.p)/CAMERA_FOV.y)*height);
      if(x>0&&x<width&&y>0&&y<height){hx=x;hy=y;hs=selfFace.size;}
    }
    const face=finder.unpack(finder.find(frame.buffer,width,height,hx,hy,hs,0,0)),spent=Time.delta(now);
    const found=!!face&&face.score>=(hs?number('selfNearScore',SELF_NEAR_SCORE):number('selfScore',SELF_SCORE));
    selfAnswer(found?face:undefined,width,height,pose,moving,!!hs,spent);
  };
  // One frame for the neural detector: a copy goes to its task and the answer is asked for at the next turns of the
  // camera timer; meanwhile JavaScript is free (voice, servos). `asked` keeps what the frame was taken with.
  // A face that is being followed is looked for quickly: only the detector's first network, near where the face must
  // be now (on the robot the second network, which says for sure that a place is a face, takes 70 ms more: 13 Nov
  // 2026). Both networks again when the face has not been seen for SELF_QUICK_MS, when a quick search finds
  // nothing, and every SELF_SURE_MS all the same, so that the head never follows something that is not a face.
  let asked,sureAt;
  const neuralStart=(frame,pose,moving)=>{
    const width=frame.width,height=frame.height;
    if(selfFace&&Time.delta(selfFace.at)>=SELF_QUICK_MS)selfFace=undefined;
    let quick=false,x=0,y=0;
    if(SELF_QUICK&&selfFace&&pose&&sureAt!==undefined&&Time.delta(sureAt)<SELF_SURE_MS){
      x=Math.round((.5-(selfFace.yaw-pose.y)/CAMERA_FOV.x)*width);y=Math.round((.5+(selfFace.pitch-pose.p)/CAMERA_FOV.y)*height);
      quick=x>0&&x<width&&y>0&&y<height;
    }
    let deep=!quick&&selfFar&&!hooks.conversation?.();
    // While the slower detector is the one that finds the face, one frame now and then goes to the quick pair; while
    // nobody is found, the slower detector takes one frame now and then and the quick pair the others.
    if(deep&&selfProbeAt!==undefined){if(Time.delta(selfProbeAt)>=SELF_DEEP_PROBE_MS){deep=false;selfProbeAt=Time.ticks;}}
    else if(deep&&selfDeepAt!==undefined&&Time.delta(selfDeepAt)<SELF_DEEP_EVERY_MS)deep=false;
    // The rover is searching with short pauses (mod.js bodyQuick, rover-follow.js): the slower detector would not end
    // before the body turns again.
    if(deep&&hooks.bodyQuick?.()&&typeof hooks.bodySearch?.()==='number')deep=false;
    // The iPhone is looking at these frames with a detector that finds more than this one, and much sooner.
    if(deep&&helperOn())deep=false;
    // The iPhone has just seen the face: the slower detector would only hold the frames back (SELF_HELP_NO_DEEP_MS).
    if(deep&&selfHelpAt!==undefined&&Time.delta(selfHelpAt)<SELF_HELP_NO_DEEP_MS&&!hooks.conversation?.())deep=false;
    if(deep)selfDeepAt=Time.ticks;
    const result=finder.startNeural(frame.buffer,width,height,deep?2:quick,x,y);
    if(result===1){asked={width,height,pose,moving,quick,deep,at:Time.ticks};if(deep&&selfStats)selfStats.deep=(selfStats.deep??0)+1;}
    return result;
  };
  const neuralPoll=()=>{
    if(!asked)return true;
    const value=finder.pollNeural();
    if(value===-1){if(Time.delta(asked.at)>SELF_NEURAL_MS){asked=undefined;return true;}return false;} // still searching
    const {width,height,pose,moving,quick,deep,at}=asked;asked=undefined;
    const seen=finder.unpackNeural(value),face=seen&&seen.score>=number('selfNeuralScore',SELF_NEURAL_SCORE)?seen:undefined;
    if(face&&!quick)sureAt=Time.ticks;
    selfAnswer(face,width,height,pose,moving,quick,Time.delta(at),deep);
    return true;
  };
  let videoJpeg=false,videoQuality=JPEG_QUALITY,videoStats;
  // The iPhone asked for the robot's video (camera.start: the Live page, or the hand gestures the app now looks for by
  // itself) and has not stopped it. While the robot follows a face by itself the camera is not switched: the video
  // goes out from the very frames of following (15 Nov 2026: before, the two took the camera from each other, and
  // with the app connected the head did not follow at all). videoHeld: a conversation is opening (mod.js).
  let videoWanted=false,videoHeld=false,selfVideoAt,selfVideoPoses=[],selfOwnAt,selfHelped=0,selfHelpAt,selfUnseen=0,selfHelpMs=0,selfHelpCount=0; // selfUnseen: frames sent to the iPhone since anyone saw the face
  // Where the head should aim instead of (x,y), for a face seen at `ago` ms ago at that place of the frame taken with
  // `pose`: ahead of it when it moves steadily (SELF_LEAD above). Gives the place to aim at, inside the frame.
  let selfTrack,selfLeads=0;
  const selfAhead=(x,y,pose,ago)=>{
    const yaw=pose.y+(.5-x)*CAMERA_FOV.x,pitch=pose.p-(.5-y)*CAMERA_FOV.y,prev=selfTrack;let vy=0,vp=0;
    // `since`: how long before now it was seen (the two sightings are compared by that, whatever the clock's origin).
    if(prev){const gap=prev.ago()-ago;if(gap>=SELF_LEAD_GAP[0]&&gap<=SELF_LEAD_GAP[1]){vy=(yaw-prev.yaw)*1000/gap;vp=(pitch-prev.pitch)*1000/gap;}}
    const from=Time.ticks;selfTrack={yaw,pitch,vy,vp,ago:()=>Time.delta(from)+ago};
    if(!SELF_LEAD||!prev)return {x,y};
    const ahead=ago/1000+SELF_LEAD_S,steady=(now,before,most)=>Math.abs(now)>=SELF_LEAD_MIN&&now*before>0?Math.max(-most,Math.min(most,now*ahead)):0;
    const ly=steady(vy,prev.vy,SELF_LEAD_MAX),lp=steady(vp,prev.vp,SELF_LEAD_MAX_UP);
    if(!ly&&!lp)return {x,y};
    selfLeads++;
    // A higher yaw is to the left of the frame, a lower pitch (up) to its top (tracker.js aim).
    return {x:Math.max(0,Math.min(1,x-ly/CAMERA_FOV.x)),y:Math.max(0,Math.min(1,y+lp/CAMERA_FOV.y))};
  };
  const helperOn=()=>SELF_HELPED_QUICK&&videoWanted&&selfHelpAt!==undefined&&Time.delta(selfHelpAt)<SELF_HELPER_MS&&!hooks.conversation?.();
  let socket,controller,heartbeat,cameraTimer,captureBusy=false,cameraActive=false,cameraMode,following=false,framePoses=[],screenActive=false,closed=false,connected=false,seq=0,frameId=0,mediaGeneration=0;
  let microphone,speaker,releaseAudio,audioQueue=[],audioBytes=0,lastPlayback,screenPort,lastAudioMouth=0,heardAt;
  const playback={last:0};
  // The Wi-Fi stays awake (socket.js lowLatency) only while the camera or a call streams: at rest the host saves power.
  // With the app in (from peer.connected to the end of this link) the radio stays awake too: a head command from the
  // iPhone must be confirmed within 1.5 s or the relay closes everything, and with the radio asleep one was not
  // (10 Nov 2026, following with the iPhone's camera: «poi si è scollegato», command_timeout with the robot idle).
  let radio,appIn=false;
  const tuneRadio=()=>{const wanted=!closed&&(cameraActive||!!microphone||appIn);if(wanted&&!radio)radio=lowLatency();else if(!wanted&&radio){const held=radio;radio=undefined;held.close();}};
  // TEMPORARY (K151 bring-up): how fast following really goes, on the USB log every 5 s (frames sent, how many of
  // them small, answers from the iPhone, answers that came too late to be used, the longest and the average wait of a
  // small frame for the next answer).
  let followStats={frames:0,small:0,answers:0,late:0,wait:0,sum:0,waits:0,at:undefined};
  const followStat=(key,small=false,waited=0)=>{
    if(typeof trace!=='function')return;
    const stats=followStats;if(stats.at===undefined)stats.at=Time.ticks;stats[key]++;if(small)stats.small++;if(waited>stats.wait)stats.wait=waited;if(waited>0){stats.sum+=waited;stats.waits++;}
    if(Time.delta(stats.at)<5000)return;
    trace(`[robottino] follow frames=${stats.frames} small=${stats.small} answers=${stats.answers} late=${stats.late} wait=${stats.wait} mean=${stats.waits?Math.round(stats.sum/stats.waits):0} in ${Time.delta(stats.at)} ms\n`);
    followStats={frames:0,small:0,answers:0,late:0,wait:0,sum:0,waits:0,at:Time.ticks};
  };
  const verified=()=>Preference.get('robottino','verified')===true;
  const calibrated=()=>Preference.get('robottino','calibrated')===true;
  const send=value=>{if(connected&&!closed)socket.write(typeof value==='string'?value:JSON.stringify(value));};
  // TEMPORARY (K151 bring-up): errors that used to end the link without a word, on the USB log.
  const note=(where,error)=>{try{if(typeof trace==='function')trace(`[robottino] live ${where}: ${error}\n`);}catch{}};
  // A microphone or speaker callback that finds a problem ends the link from a timer, never from inside itself: an
  // audio driver must not be closed inside its own callback, and no error may leave the callback (see call below).
  // The iPhone sees the link close: a call that broke is never shown as going on.
  let failing;
  const failLater=(where,error)=>{try{if(failing!==undefined||closed)return;note(where,error);failing=Timer.set(()=>{failing=undefined;close();},0);}catch{}};
  // TEMPORARY (K151 bring-up, 10 Nov 2026): how a call really goes, on the USB log every 5 s and when it ends.
  // Microphone: callbacks, bytes read (16 kHz PCM16), the largest read (a full quarter of a second, 8192, means
  // JavaScript was late), bytes sent (µ-law: one for every four read), bytes not sent because the connection was full
  // (µ-law) or because the speaker was playing (PCM16). Speaker: bytes that came from the iPhone (µ-law), bytes
  // dropped because 0.4 s already waited (µ-law), pieces that were not call audio in this format, bytes played and
  // bytes of silence played instead (PCM16), write errors.
  let callStats;
  const showCall=()=>{
    const s=callStats;if(!s||typeof trace!=='function')return;
    trace(`[robottino] call mic=${s.reads} read=${s.read} most=${s.most} sent=${s.sent} full=${s.full} gated=${s.gated} heard=${s.heard} over=${s.over} bad=${s.bad} played=${s.played} silence=${s.silence} errors=${s.errors} in ${Time.delta(s.at)} ms\n`);
    s.reads=s.read=s.most=s.sent=s.full=s.gated=s.heard=s.over=s.bad=s.played=s.silence=0;s.at=Time.ticks;
  };
  const stopCall=()=>{
    if(callStats){try{showCall();}catch{}callStats=undefined;}
    try{microphone?.close();}catch{}microphone=undefined;try{speaker?.close();}catch{}speaker=undefined;tuneRadio();
    audioQueue=[];audioBytes=0;playback.last=0;lastPlayback=undefined;lastAudioMouth=0;try{releaseAudio?.();}catch{}releaseAudio=undefined;robot.face.setMouthOpen(0);
  };
  // One frame at a time, written piece by piece while the socket has room; the camera frame stays with the driver
  // until its last piece is written, then goes back.
  let sending;
  const finishFrame=()=>{const frame=sending?.frame;sending=undefined;captureBusy=false;try{frame?.close?.();}catch{}};
  const pumpFrame=()=>{
    while(sending){
      if(closed||!connected||!cameraActive||sending.generation!==mediaGeneration){finishFrame();return;}
      if((socket?.bufferedAmount??0)>SEND_BACKLOG)return;
      let next;try{const from=Time.ticks;next=sending.pieces.next();const made=Time.delta(from);if(!next.done){socket.write(next.value);socket.note?.('p',made,Time.delta(from)-made);}}catch{finishFrame();close();return;}
      if(next.done){finishFrame();return;}
      // Grey pieces are converted as they go (greyChunks, windowChunks): one per camera tick (25 ms), so the robot is
      // never busy converting a whole frame at once; the camera frame goes back as soon as the last one is written.
      if(sending.paced){if(--sending.paced<=0)finishFrame();return;}
    }
  };
  const servosConfirmed=async()=>{for(let waited=0;waited<CAMERA_WAIT_MS&&hooks.motionBusy?.();waited+=20)await new Promise(resolve=>Timer.set(resolve,20));};
  const switchCamera=async action=>{await servosConfirmed();cameraSwitching++;try{return await action();}finally{cameraSwitching--;}};
  // «Cos'è questo?» (11 Nov 2026): one colour picture for the conversation (voice-wire.js pictureChunks), given piece
  // by piece to `sink` (true: taken; false: no room now, the same piece is offered again; an error ends it). With the
  // camera already on (video, following) the next frame is used; otherwise the camera is switched on for this alone
  // (mode 'snap': nothing goes to the iPhone), lets the exposure settle and is switched off again. The camera frame
  // stays with the robot until its last piece has gone.
  const SNAP_WARM_MS=900,SNAP_MS=7000;let snap;
  const endSnap=ok=>{
    const done=snap;if(!done)return;snap=undefined;
    if(done.frame){try{done.frame.close?.();}catch{}captureBusy=false;}
    if(done.own&&cameraMode==='snap')void stopCamera().catch(()=>{});
    try{done.resolve(ok);}catch{}
  };
  // How the JPEG video goes, on the log every 5 s: pictures sent, their mean and largest size, the quality now, the
  // longest time the host took to make one, pictures that waited for room in the connection.
  const showVideo=force=>{
    const v=videoStats;if(!v||typeof trace!=='function'||(!force&&Time.delta(v.at)<5000))return;
    if(v.frames)trace(`[robottino] video jpeg frames=${v.frames} bytes=${Math.round(v.bytes/v.frames)}/${v.most} q=${videoQuality} ms=${v.ms} waited=${v.waited} in ${Time.delta(v.at)} ms\n`);
    videoStats={frames:0,bytes:0,most:0,ms:0,waited:0,at:Time.ticks};
  };
  const stopCamera=async()=>{if(snap){snap.own=false;endSnap(false);}if(videoStats){try{showVideo(true);}catch{}videoStats=undefined;try{finder?.videoEnd?.();}catch{}}cameraActive=false;cameraMode=undefined;mediaGeneration++;finishFrame();tuneRadio();if(cameraTimer!==undefined)Timer.clear(cameraTimer);cameraTimer=undefined;await switchCamera(()=>robot.camera?.stop());};
  const stopFollowing=()=>{if(!following)return;following=false;framePoses=[];lock.clear();hooks.follow?.(false);};
  // mode 'video': 160×120 colour every 333 ms; 'track': the same camera size in grey for following.
  const startCamera=async mode=>{
    if(cameraActive){if(cameraMode===mode)return;await stopCamera();}
    if(!verified()||robot.camera?.available===false||!robot.camera?.capture)throw Error('camera_unavailable');
    const options={...(mode==='track'?TRACK_SIZE:VIDEO_SIZE),imageType:'rgb565le'},generation=++mediaGeneration;
    await switchCamera(()=>robot.camera.start(options));
    if(closed||generation!==mediaGeneration){await switchCamera(()=>robot.camera.stop());throw Error('cancelled');}
    cameraActive=true;cameraMode=mode;tuneRadio();let lastSent;const startedAt=Time.ticks;
    // The camera coming back (after the opening of a conversation, for one): where a face was seen is still known.
    if(mode==='self'){selfStep=0;selfWaitFrom=undefined;selfLast=undefined;selfGone=0;selfMissFrom=undefined;selfLookFrom=Time.ticks;selfFar=false;selfProbeAt=undefined;selfDriftX=selfDriftY=0;selfPlan=undefined;if(neural){try{finder.neuralSize?.(SELF_NET[0],SELF_NET[1]);}catch{}}}
    const still=()=>mode!=='track'||!hooks.headMoving?.()||Time.delta(lastSent??startedAt)>=TRACK_STILL_WAIT_MS;
    // TEMPORARY (K151 bring-up, 10 Nov 2026): where the time of one following frame goes (socket.js probe), on the
    // USB log every 5 s: late timer turns (g), capture asked and done (c, C), pieces made and written (p).
    let lastTurn,probeShown=Time.ticks,probing=false;
    // Following alone: one frame, searched as soon as the camera gives it. The next one is asked for at once (a turn
    // of the program later, so everything else still gets its turn), not at the next tick of the camera timer: with
    // the timer alone each frame waited up to 25 ms more (13 Nov 2026: 13 frames a second with a 39 ms search).
    let pollTimer;
    // The K210 camera on the head (k210.js, 23 Nov 2026): while it sends pictures, its faces are the ones followed, each
    // new one once, only with the head still (as the robot camera's: one taken on the way shows the face off the
    // middle); the robot camera's search does not run, and its pictures are taken only for the iPhone's video.
    let k210Seq;
    const k210Turn=k=>{
      if(k.seq===k210Seq)return;k210Seq=k.seq;
      // Still enough for the K210 (k210Settled, a shorter wait than the robot camera's), or for the robot camera.
      if(hooks.k210Settled?!hooks.k210Settled():hooks.headSettled?!hooks.headSettled():!!hooks.headMoving?.())return;
      const view=k210View(k,CAMERA_FOV);
      selfAnswer(view?{x:view.x*FRAME_WIDTH,y:view.y*FRAME_HEIGHT,size:view.size*FRAME_WIDTH}:undefined,FRAME_WIDTH,FRAME_HEIGHT,hooks.headPose?.(),false,false,k.ms,false);
    };
    // The K210's own small picture for the iPhone's video (23 Nov 2026, owner: «nella live dell'app si deve vedere la
    // nuova camera»): when the camera sends them (k210.js image), they are the video, each one once, with the room
    // the JPEG needs; the robot camera's pictures are not taken. false: the K210 sends none, the robot camera goes on.
    let k210Shown;
    const k210Video=()=>{
      const image=hooks.k210Image?.();if(!image)return false;
      if(image.id===k210Shown||(socket?.bufferedAmount??0)>SEND_BACKLOG||(socket?.room??JPEG_ROOM)<JPEG_ROOM)return true;
      const talking=!!hooks.conversation?.();if(talking&&!hooks.listening?.())return true; // the voice comes first
      k210Shown=image.id;
      try{socket.write(jpegFrame(image.buffer,++seq,image.width,image.height));selfVideoAt=lastSent=Time.ticks;if(videoStats){const v=videoStats,size=image.buffer.byteLength-JPEG_HEAD;v.frames++;v.bytes+=size;if(size>v.most)v.most=size;showVideo();}}
      catch(error){note('k210 video',error);}
      return true;
    };
    const selfTurn=()=>{
      if(mode!=='self'||!cameraActive||closed||generation!==mediaGeneration||snap||hooks.motionBusy?.()||hooks.starting?.()||hooks.mediaPaused?.())return;
      const k=hooks.k210?.();
      if(k){try{k210Turn(k);}catch(error){note('self k210',error);}if(!videoWanted||!videoJpeg||k210Video())return;}
      if(captureBusy)return;
      const talk=neural&&!!hooks.conversation?.(),speaking=!!hooks.speaking?.();
      if(!talk&&speaking&&lastSent!==undefined&&Time.delta(lastSent)<(neural?SELF_NEURAL_SPEAK_MS:SELF_SPEAK_MS))return;
      if(!k&&neural&&!neuralPoll()){if(pollTimer===undefined)pollTimer=Timer.set(()=>{pollTimer=undefined;selfTurn();},SELF_POLL_MS);return;} // still on the last frame: asked again in a moment
      // Only with the head still (13 Nov 2026, after the external RAM went to 80 MHz: «l'inseguimento mi sembra
      // peggiorato»). The pose given with a frame is where the head has been told to go; the servos get there later,
      // so a frame taken on the way shows the face still off the middle and the head was sent further by half of
      // that again, each time: past the face, then back. With a search of 0.19 s the next frame came when the head
      // had arrived; at 0.08 s two or three came on the way. The answer already asked for is still taken above.
      // When the head has really arrived is said by mod.js headSettled (14 Nov 2026: measured with the camera itself, a
      // third of a second after the servos confirm the command; the wait reckoned before ended while half of the moves
      // were still going on). With a host that does not say it, the older wait.
      if(neural&&(hooks.headSettled?!hooks.headSettled():!!hooks.headMoving?.()))return;
      if(talk&&lastSent!==undefined&&Time.delta(lastSent)<(speaking?SELF_TALK_SPEAK_MS:SELF_TALK_MS))return;
      captureBusy=true;
      void robot.camera.capture(options).then(frame=>{
        captureBusy=false;if(!frame)return;
        try{
          if(!cameraActive||generation!==mediaGeneration||closed||frame.imageType!=='rgb565le'||hooks.motionBusy?.())return;
          lastSent=Time.ticks;
          if(k);else if(neural)neuralStart(frame,hooks.headPose?.(),!!hooks.headMoving?.());
          else selfFrame(frame,hooks.headPose?.(),!!hooks.headMoving?.());
          // The same frame for the iPhone, as a JPEG, when it asked for the video: at most one every SELF_VIDEO_MS, only
          // with the connection free, never in a conversation (the voice comes first).
          const talking=!!hooks.conversation?.();
          if(videoWanted&&videoJpeg&&(!talking||hooks.listening?.())&&(selfVideoAt===undefined||Time.delta(selfVideoAt)>=(talking?SELF_VIDEO_TALK_MS:SELF_VIDEO_MS))&&(socket?.bufferedAmount??0)<=SEND_BACKLOG&&(socket?.room??JPEG_ROOM)>=JPEG_ROOM){
            let out;try{out=finder.videoJpeg(frame.buffer,frame.width,frame.height,videoQuality,JPEG_HEAD);}catch(error){out=String(error);}
            if(out instanceof ArrayBuffer){
              selfVideoAt=Time.ticks;const size=out.byteLength-JPEG_HEAD,id=++seq;socket.write(jpegFrame(out,id,frame.width,frame.height));videoQuality=jpegQuality(videoQuality,size);
              // Where the head was for this frame: an answer of the iPhone about it is turned into a place with this.
              const pose=hooks.headPose?.();if(pose){selfVideoPoses.push({id,pose,at:Time.ticks});if(selfVideoPoses.length>SELF_VIDEO_POSES)selfVideoPoses.shift();}
              selfUnseen++;
            }
            else{videoJpeg=false;note('self video',out);}
          }
        }catch(error){note('self',error);}
        finally{try{frame.close?.();}catch{}}
        if(!neural)Timer.set(selfTurn,0);
      }).catch(()=>{captureBusy=false;});
    };
    cameraTimer=Timer.repeat(()=>{
      if(lastTurn!==undefined&&Time.delta(lastTurn)>60)socket?.note?.('g',Time.delta(lastTurn));
      lastTurn=Time.ticks;
      // A head command waiting for the servos comes first: no capture, conversion or sending until it is confirmed,
      // so the servo replies are read at once (mod.js motionBusy, 9 Nov 2026).
      const paused=hooks.motionBusy?.()||hooks.mediaPaused?.();
      if(snap){
        const elapsed=Time.delta(snap.last);snap.last=Time.ticks;
        if(!paused)snap.elapsed+=elapsed;
        if(snap.elapsed>SNAP_MS||Time.delta(snap.at)>30000){endSnap(false);return;}
      }
      if(paused)return;
      if(sending){pumpFrame();return;}
      if(snap){
        if(snap.pieces){
          // One piece per turn of the timer, while the conversation's connection has room.
          try{
            snap.piece??=snap.pieces.next();
            if(snap.piece.done){endSnap(true);return;}
            if(snap.sink(snap.piece.value))snap.piece=undefined;
          }catch{endSnap(false);}
          return;
        }
        if(captureBusy||Time.delta(startedAt)<(mode==='snap'?SNAP_WARM_MS:0)||hooks.headMoving?.())return;
        captureBusy=true;
        void robot.camera.capture(options).then(frame=>{
          if(!frame){captureBusy=false;return;}
          if(!snap||snap.frame||generation!==mediaGeneration||closed||frame.imageType!=='rgb565le'){try{frame.close?.();}catch{}captureBusy=false;if(snap&&!snap.frame&&frame.imageType!=='rgb565le')endSnap(false);return;}
          snap.frame=frame;try{snap.pieces=pictureChunks(frame.buffer,frame.width,frame.height);}catch{endSnap(false);}
        }).catch(()=>{captureBusy=false;endSnap(false);});
        return;
      }
      if(mode==='snap')return; // the camera is on only for a picture: nothing goes to the iPhone
      if(mode==='self'){selfTurn();return;}
      // While Robottino talks, following sends nothing (owner, 11 Nov 2026: «la voce va a scatti» with the app following
      // the face during the conversation): taking, converting and sending an image holds JavaScript for 0.1-0.25 s, four
      // times a second, and the speaker ran dry. The head stays where it is for the length of the reply and following
      // goes on as soon as the robot listens again.
      if(mode==='track'&&hooks.speaking?.())return;
      if(captureBusy||!cameraActive||closed||(socket?.bufferedAmount??0)>SEND_BACKLOG)return;
      // Following: the whole frame, or a small image of where the face should be now (tracker.js FaceLock).
      const track=mode==='track',pose=track?hooks.headPose?.():undefined,cut=track?lock.plan(pose,Time.ticks,!!hooks.listening?.()):undefined;
      const jpeg=mode==='video'&&videoJpeg;
      const gap=track?(cut?TRACK_SMALL_FRAME_MS:hooks.conversation?.()?TRACK_VOICE_FRAME_MS:TRACK_FRAME_MS):jpeg?(microphone?VIDEO_JPEG_CALL_MS:VIDEO_JPEG_MS):VIDEO_FRAME_MS;
      if(lastSent!==undefined&&Time.delta(lastSent)<gap)return;
      // A JPEG picture waits for the room to leave in one go, like the small image of following below.
      if(jpeg&&lastSent!==undefined&&Time.delta(lastSent)<JPEG_ROOM_WAIT_MS&&(socket?.room??JPEG_ROOM)<JPEG_ROOM){if(videoStats)videoStats.waited++;return;}
      // The small image waits for the room to leave in one go (the network has confirmed what went before; by then
      // the camera has a new image ready too, so the capture does not hold the robot).
      if(cut&&lastSent!==undefined&&Time.delta(lastSent)<SMALL_ROOM_WAIT_MS&&(socket?.room??SMALL_ROOM)<SMALL_ROOM)return;
      if(!still())return;
      if(jpeg&&videoJpeg&&k210Video())return; // the K210's pictures, when it sends them
      captureBusy=true;
      if(probing&&Time.delta(probeShown)>=5000&&typeof trace==='function'){probeShown=Time.ticks;for(const line of socket?.probeLines?.()??[])trace(`[robottino] probe${line}\n`);}
      probing=true;socket?.probeStart?.();socket?.note?.('c');
      void robot.camera.capture(options).then(frame=>{
        socket?.note?.('C');
        if(!frame){captureBusy=false;return;}
        if(!cameraActive||generation!==mediaGeneration||closed||hooks.motionBusy?.()||!still()){try{frame.close?.();}catch{}captureBusy=false;return;}
        if(frame.imageType!=='rgb565le'||frame.width>320||frame.height>240){try{frame.close?.();}catch{}throw Error('camera_format');}
        if(jpeg&&videoJpeg){
          // Made by the host and written whole in this turn; the camera frame goes back at once. If the host cannot
          // make it, the video goes on as raw pieces from this picture on (and the log says why).
          let out;try{out=finder.videoJpeg(frame.buffer,frame.width,frame.height,videoQuality,JPEG_HEAD);}catch(error){out=String(error);}
          if(out instanceof ArrayBuffer){
            const width=frame.width,height=frame.height;try{frame.close?.();}catch{}captureBusy=false;lastSent=Time.ticks;
            const size=out.byteLength-JPEG_HEAD;socket.write(jpegFrame(out,++seq,width,height));
            if(videoStats){const v=videoStats,ms=finder.videoMs?.()??0;v.frames++;v.bytes+=size;if(size>v.most)v.most=size;if(ms>v.ms)v.ms=ms;showVideo();}
            videoQuality=jpegQuality(videoQuality,size);
            return;
          }
          videoJpeg=false;note('video jpeg',out);
        }
        const id=++frameId;lastSent=Time.ticks;
        // The small image is cut only from the camera's own 160×120 frame.
        const small=cut&&frame.width===FRAME_WIDTH&&frame.height===FRAME_HEIGHT?cut:undefined;
        if(pose){framePoses.push({id,pose,window:small});if(framePoses.length>TRACK_POSES)framePoses.shift();}
        if(track){lock.sent(small,lastSent);followStat('frames',!!small);}
        // Grey for following (live-wire.js: the small image, or the whole frame, found from much farther away),
        // converted piece by piece as it is sent; the camera frame goes back after the last piece.
        let pieces,paced=0;
        try{
          if(small){
            pieces=windowChunks(id,frame.buffer,frame.width,frame.height,small.x0,small.y0,small.step,()=>++seq);
            // The small image leaves in one turn when the connection has room for all of it (about 0.1 s of work):
            // one piece per turn cost two more turns of the timer, 0.1-0.25 s each with the robot busy (probe of
            // 10 Nov 2026 night: 450 ms from the capture to the last piece). Without room, one piece per turn as before.
            paced=(socket?.room??0)>=SMALL_ROOM?0:SMALL_PIECES;
          }
          else if(track){pieces=greyChunks(id,frame.buffer,frame.width,frame.height,()=>++seq);paced=Math.ceil(frame.width*frame.height/CAMERA_PIECE);}
          else pieces=cameraChunks(id,frame.buffer,frame.width,frame.height,()=>++seq);
        }catch(error){try{frame.close?.();}catch{}throw error;}
        sending={frame,generation,pieces,paced};pumpFrame();
      }).catch(()=>{if(!sending)captureBusy=false;close();});
    },PUMP_MS);
  };
  const io={
    // jpeg: the iPhone asked for JPEG pictures (and the server let the request through); used when this host can make them.
    async camera(enabled,jpeg=false){
      // The iPhone's «Segui il mio viso» follows with the robot's own frames (self): the video for the gestures goes out
      // from them too (23 Nov 2026: refused, the gestures stopped at every conversation).
      if(cameraMode==='track')throw Error('camera_busy'); // following with the iPhone's answers owns the camera until track.stop
      if(!enabled){videoWanted=false;if(cameraMode!=='self')await stopCamera();return;} // following alone goes on (mod.js stops it)
      videoJpeg=jpeg===true&&typeof finder?.videoJpeg==='function';videoQuality=JPEG_QUALITY;
      // Following alone has the camera: the video goes out from its frames (JPEG only), nothing is switched.
      if(cameraMode==='self'){if(!videoJpeg)throw Error('camera_busy');videoWanted=true;return;}
      videoWanted=true;
      if(videoHeld)return; // a conversation is opening: the video starts when it is ready (videoSync)
      await startCamera('video');
      if(videoJpeg&&!videoStats)videoStats={frames:0,bytes:0,most:0,ms:0,waited:0,at:Time.ticks};
    },
    // The head may move only as for the other remote motions: verified, calibrated, motions on locally.
    async track(enabled){
      if(!enabled){stopFollowing();if(cameraMode==='track'||cameraMode==='self'&&!selfWanted)await stopCamera();return;}
      if(!verified()||!calibrated())throw Error('uncalibrated');
      if(following)return;
      hooks.follow(true);following=true;lock.clear();
      // With the face finder in the host the robot follows by itself, for the iPhone's «Segui il mio viso» too: no
      // frame goes to the iPhone, which only starts and stops it.
      try{await startCamera(finder&&selfOn()?'self':'track');}catch(error){stopFollowing();throw error;}
    },
    target(value){
      // The iPhone's answer about a frame of following's own video: taken when the robot's own detector is blind.
      const helped=!following&&cameraMode==='self'?selfVideoPoses.find(item=>item.id===value.frameId):undefined;
      if(helped){
        selfHelpAt=Time.ticks;selfUnseen=0; // the iPhone is looking, and sees the face
        selfHelpMs+=Time.delta(helped.at);selfHelpCount++; // from the frame leaving the robot to its answer coming back
        if(selfOwnAt!==undefined&&Time.delta(selfOwnAt)<SELF_HELP_AFTER_MS)return; // the robot sees the face itself: its own answers are newer
        // The K210 leads (23 Nov 2026): the iPhone answers about the robot camera's pictures, mounted otherwise; on the
        // robot they took the head 68° away from the owner while the K210 had lost him for a moment.
        if(hooks.k210?.())return;
        const x=value.x,y=value.y;
        selfStep=0;selfWaitFrom=undefined;selfSeenAt=selfFoundAt=Time.ticks;selfGone=0;selfMissFrom=undefined;selfBodyStep=undefined;
        selfLast={x,y};selfDriftX=selfDriftX*.5+(x-.5)*.5;selfDriftY=selfDriftY*.5+(y-.5)*.5;
        selfFace={yaw:helped.pose.y+(.5-x)*CAMERA_FOV.x,pitch:helped.pose.p-(.5-y)*CAMERA_FOV.y,size:40,at:Time.ticks};
        selfHome={yaw:selfFace.yaw,pitch:selfFace.pitch,at:Time.ticks};
        selfHelped++;const to=selfAhead(x,y,helped.pose,Time.delta(helped.at));hooks.aim({x:to.x,y:to.y,pose:helped.pose,gain:SELF_GAIN});
        return;
      }
      const entry=following?framePoses.find(item=>item.id===value.frameId):undefined;
      if(following)followStat(entry?'answers':'late',false,entry&&lock.since!==undefined?Time.delta(lock.since):0);
      if(!entry)throw Error('stale_frame'); // an answer for an old or unknown frame moves nothing
      // Where the face is in the whole frame (the answer may be about a small window of it). An answer at the edge
      // (a face cut by the image, or the iPhone's guess of where a lost face went) turns the head to that edge and
      // the next frame is whole (tracker.js FaceLock).
      const place=lock.answer(entry,value.x,value.y,Time.ticks);
      if(place&&!hooks.aim({x:place.x,y:place.y,pose:entry.pose}))throw Error('target_rejected');
    },
    call(enabled){
      if(!enabled){stopCall();return;}
      if(microphone)return;if(!verified())throw Error('hardware_unverified');
      // The robot's own microphones (asleep, «guardalo e parla») close first: never two open (mod.js).
      try{hooks.callStarting?.();}catch{}
      releaseAudio=robot.audio.acquireExclusive();
      try{
        const stats=callStats={reads:0,read:0,most:0,sent:0,full:0,gated:0,heard:0,over:0,bad:0,played:0,silence:0,errors:0,at:Time.ticks};
        // The microphone's sound becomes pieces of 800 bytes of µ-law (live-wire.js CallPacker), one message each:
        // ten a second instead of fifty, a quarter of the bytes.
        const packer=new CallPacker(),sendPiece=piece=>{
          if((socket?.bufferedAmount??0)>(cameraActive?CALL_CAMERA_BACKLOG:CALL_BACKLOG)){stats.full+=piece.length;return;}
          if(connected&&!closed){socket.write(encodeCallAudio(++seq,piece));stats.sent+=piece.length;}
        };
        // No error may leave the two callbacks below. The host calls the microphone's without catching anything: an
        // error there ends the JavaScript machine and the robot restarts with nothing on the log (10 Nov 2026: every
        // call in which the iPhone sent its voice restarted the robot after 2-3 s). The speaker's errors the host
        // swallows without a word.
        speaker=new AudioOut({sampleRate:16000,channels:1,bitsPerSample:16,onWritable(size){
          try{
            while(size>0){
              const head=audioQueue[0],length=Math.min(size,head?.byteLength??SILENCE.byteLength);
              if(head){const part=head.subarray(0,length);this.write(part);audioBytes-=length;stats.played+=length;const mouth=pcmMouthLevel(part);if(mouth)lastPlayback=Time.ticks;if(mouth!==lastAudioMouth){lastAudioMouth=mouth;robot.face.setMouthOpen(mouth);}if(length===head.byteLength)audioQueue.shift();else audioQueue[0]=head.subarray(length);}
              else {this.write(length===SILENCE.byteLength?SILENCE:SILENCE.subarray(0,length));stats.silence+=length;if(lastAudioMouth){lastAudioMouth=0;robot.face.setMouthOpen(0);}}
              size-=length;
            }
          }catch(error){if(!stats.errors++)note('call speaker',error);}
        }});
        speaker.volume=.25;if(globalThis.amp)globalThis.amp.sampleRate=16000;
        microphone=new AudioIn({sampleRate:16000,channels:1,bitsPerSample:16,onReadable(){
          try{
            // Read what is there, as the voice does (voice-device.js), never the size the host announced: the
            // microphone keeps a quarter of a second, and when JavaScript is late it goes round in the meantime;
            // the announced size is then more than what is left and the read fails with "invalid size".
            const data=this.read();if(!data)return;
            const length=data.byteLength;stats.reads++;stats.read+=length;if(length>stats.most)stats.most=length;
            if(Time.delta(stats.at)>=5000)showCall();
            // Gated microphone while speaker is active: prevents an acoustic loop;
            // hardware AEC/full-duplex speech must be measured on the real robot.
            if(lastPlayback!==undefined&&Time.delta(lastPlayback)<180){stats.gated+=length;packer.clear();return;}
            // Read at every callback, so the microphone's quarter of a second never fills; sent when a piece is whole.
            packer.add(data,sendPiece);
          }catch(error){failLater('call mic',error);}
        }});
        if(microphone.sampleRate!==16000||microphone.channels!==1||microphone.bitsPerSample!==16)throw Error('audio_format');
        speaker.start();microphone.start();tuneRadio();
      }catch(error){stopCall();throw error;}
    },
    screen(enabled){
      if(enabled&&!verified())throw Error('hardware_unverified');screenActive=enabled;
      if(!enabled){screenPort=undefined;robot.ui.showFace();}
    },
    audio(data){
      if(!speaker)return;
      // Only call audio in the call's format (live-wire.js): anything else is dropped, never played as noise.
      const count=callAudioLength(data);if(!count){if(callStats)callStats.bad++;return;}
      if(audioBytes+count*4>CALL_PLAY_QUEUE){if(callStats)callStats.over+=count;return;}
      const buffer=decodeCallAudio(data,playback);audioQueue.push(buffer);audioBytes+=buffer.byteLength;if(callStats)callStats.heard+=count;
    },
    image(frame){
      if(!screenActive)return;
      const be=config.format==='RGB565BE',pixels=screenPixels(frame,be);
      const scale=frame.scale??2,bitmap=new Bitmap(frame.width*scale,frame.height*scale,be?Bitmap.RGB565BE:Bitmap.RGB565LE,pixels,0);
      if(!screenPort){
        screenPort=new RuntimeBitmapPort(null,{left:0,top:0,width:320,height:240,Behavior:class extends Behavior{
          onDraw(port){port.fillColor('#07101f',0,0,320,240);if(this.bitmap)port.drawBitmap(this.bitmap,Math.floor((320-this.bitmap.width)/2),Math.floor((240-this.bitmap.height)/2));}
        }});
        robot.ui.setMain(new Container(null,{left:0,top:0,width:320,height:240,contents:[screenPort]}));
      }
      screenPort.behavior.bitmap=bitmap;screenPort.invalidate();
    },
    faceStyle:style=>{if(!verified()||screenActive)throw Error("face_unavailable");hooks.faceStyle(style);},
    motion:async value=>{if(!verified()||!calibrated())throw Error('uncalibrated');await hooks.motion(value);},
    // ACK means the dance started; STOP or a disconnect cancels it.
    dance:steps=>{if(!verified()||!calibrated())throw Error('uncalibrated');hooks.dance(steps);},
    // The rover's keys (Live, 14 Nov 2026): ACK means the move started; the robot stops it after ms by itself.
    rover:(move,ms)=>{if(!hooks.rover?.(move,ms))throw Error('rover_unavailable');},
    // The speaker volume (15 Nov 2026): the ACK says the amplifier took it and the level is saved.
    volume:level=>{if(!hooks.volume?.(level))throw Error('volume_unavailable');},
    // A hand gesture (15 Nov 2026): the ACK says the robot did what goes with it.
    gesture:name=>{if(!hooks.gesture?.(name))throw Error('gesture_unavailable');},
    // What else the iPhone saw (15 Nov 2026): the ACK says the robot took it.
    sight:(kind,text)=>{if(!hooks.sight?.(kind,text))throw Error('sight_unavailable');},
    // The motions switch (15 Nov 2026): the ACK says it is off, or that switching on has started.
    motions:on=>{if(!hooks.motions?.(on))throw Error('motions_unavailable');},
    // «Inseguimento con rover» (15 Nov 2026): the ACK says it is on (rover and distance sensor answering) or off.
    roverFollow:on=>{if(!hooks.roverFollow?.(on))throw Error('follow_unavailable');},
    // «Chiamata con lo sguardo» (21 Nov 2026): the ACK says the choice is saved.
    gazeCall:on=>{if(!hooks.gazeCall?.(on))throw Error('gaze_unavailable');},
    // Where the iPhone sees the hand that leads the Force (mod.js handAt): refused when the Force follows nothing.
    hand:x=>{if(!hooks.handAt?.(x))throw Error('not_following');},
    // «Esplora» (mod.js explore): the ACK says it has started (or a conversation is being opened for it), or stopped.
    explore:on=>{if(!hooks.explore?.(on))throw Error('explore_unavailable');},
    face:value=>{robot.face.setEyeOpen('left',value.leftEye);robot.face.setEyeOpen('right',value.rightEye);robot.face.setMouthOpen(value.mouth);robot.face.setEmotion(value.mouth>.35?3:0);},
    // emergency: the iPhone's STOP command. A link that simply closes stops only what the iPhone started.
    // The camera stops first, and the face comes back only if an iPhone image was on the screen: with the face shown
    // again while the camera still ran, the robot restarted every time the link closed during following (9 Nov 2026).
    async stop(emergency=false){
      stopFollowing();const wheels=hooks.stop(emergency);
      try{await stopCamera();}catch{}
      stopCall();robot.face.setEyeOpen('left',1);robot.face.setEyeOpen('right',1);robot.face.setEmotion(0);
      if(screenActive){screenActive=false;screenPort=undefined;robot.ui.showFace();}
      // Everything else is stopped first; then a STOP whose wheels were not confirmed still is answered as failed.
      if(emergency&&wheels===false)throw Error('rover_stop_failed');
    }
  };
  const hello=()=>send({type:'hello',capabilities:{hardwareVerified:verified(),calibrated:calibrated(),motion:verified()&&calibrated()&&hooks.motionEnabled(),camera:verified()&&!!robot.camera?.capture,audio:verified()&&!!robot.audio?.acquireExclusive,screen:verified(),conversation:!!hooks.conversation?.(),rover:!!hooks.roverReady?.(),roverFollow:!!hooks.roverFollowing?.(),gazeCall:!!hooks.gazeCalling?.(),forceFollow:!!hooks.forceFollowing?.(),exploring:!!hooks.exploring?.(),...(hooks.climate?.()?{climate:hooks.climate()}:{})}});
  const close=()=>{if(closed)return;closed=true;connected=false;following=false;framePoses=[];lock.clear();finishFrame();tuneRadio();if(failing!==undefined){Timer.clear(failing);failing=undefined;}controller?.close();if(heartbeat!==undefined)Timer.clear(heartbeat);heartbeat=undefined;socket?.close();hooks.disconnected();};
  const connect=async()=>{
    const token=Preference.get('robottino','deviceToken');if(typeof token!=='string'||token.length<32){robot.ui.showBalloon('Live: configura la credenziale dedicata del robot.');return;}
    const network=await robot.connectivity.network?.ready;if(closed)return;
    await servosConfirmed();if(closed)return; // the TLS handshake keeps the robot busy: not over a servo command
    socket=new Client({host:'robottino-stackchan.example.workers.dev',port:443,path:'/api/robot/device',headers:['Authorization','Bearer '+token]});
    controller=new DeviceCommands(io,send);
    socket.callback=(type,value)=>{
      if(closed)return;
      try{
        if(type===Client.handshake){
          connected=true;heardAt=Time.ticks;hooks.online?.();hello();
          heartbeat=Timer.repeat(()=>{
            try{
              // Not even the answers to the pings for 12 s: the link ends here (LINK_SILENCE_MS).
              if(Time.delta(heardAt)>LINK_SILENCE_MS){note('heartbeat','nothing from the server');close();return;}
              send({type:'ping'});hello();
            }catch(error){note('heartbeat',error);close();}
          },5000);
        }else if(type===Client.receive){
          heardAt=Time.ticks;
          if(typeof value==='string'){
            const event=JSON.parse(value);
            if(event.type==='command')void controller.command(event);
            if(event.type==='peer.connected'){appIn=true;tuneRadio();hooks.connected();}
            if(event.type==='reaction')hooks.reaction?.(event.kind);
          }else controller.media(value);
        }else if(type===Client.disconnect)close();
      }catch(error){note('link',error);close();}
    };
  };
  // Following alone, asked by mod.js for the length of a conversation (true) or stopped (false). The camera is taken
  // only when nothing else uses it; the iPhone's video takes it back when asked (io.camera).
  const self=async enabled=>{
    selfWanted=!!enabled;selfStep=0;selfWaitFrom=undefined;asked=undefined;sureAt=undefined;
    if(!enabled){
      selfFace=undefined;
      if(cameraMode==='self'&&!following){
        // The iPhone still wants the video: the camera goes on for it alone (not while a conversation opens).
        if(videoWanted&&!videoHeld&&!closed)await startCamera('video');else await stopCamera();
      }
      return;
    }
    if(!finder)throw Error('finder_unavailable');
    if(!verified()||!calibrated())throw Error('uncalibrated');
    // The camera was on only for the iPhone's video: following takes it and goes on sending the video from its frames.
    if(cameraActive&&cameraMode!=='self'&&!(cameraMode==='video'&&videoWanted&&videoJpeg))throw Error('camera_busy');
    if(!cameraActive||cameraMode!=='self')await startCamera('self');
  };
  const snapshot=async sink=>{
    if(closed||snap||!verified())return false;
    let own=false;
    if(!cameraActive){try{await startCamera('snap');own=true;}catch{return false;}}
    if(closed||!cameraActive||snap){if(own&&cameraMode==='snap')void stopCamera().catch(()=>{});return false;}
    return new Promise(resolve=>{snap={sink,resolve,own,at:Time.ticks,last:Time.ticks,elapsed:0};});
  };
  // A voice was heard while nobody was in sight (mod.js, sound-ear.js; owner, 14 Nov 2026: «girarsi verso la voce
  // quando non ti vede»): the look around begins again, its first move toward the side the voice came from (1 the
  // robot's left, −1 its right, 0 not known), and the count of the time with nobody starts again, so the robot is
  // awake for another half minute. The side is only as good as two microphones almost in the same place can give.
  const selfWake=side=>{
    if(!cameraActive||cameraMode!=='self')return false;
    selfLookFrom=Time.ticks;selfStep=0;selfPlan=undefined;selfWaitFrom=undefined;selfSeenAt=undefined;
    selfDriftX=side>0?-.5:side<0?.5:0;selfDriftY=0; // left in the picture is a higher yaw (selfScan)
    if(typeof trace==='function')trace(`[robottino] self wake ${side}\n`);
    return true;
  };
  // The side the face was going to when it was last seen (owner, 15 Nov 2026: «se vede la persona che sparisce sulla
  // sinistra deve girarsi a sinistra e viceversa»): 1 the robot's left, −1 its right, 0 not known. Each frame is taken
  // with the head still after a correction, so where the face is off the middle is the way it has gone since: the last
  // frame when it is clear (SELF_DRIFT of the picture: less is the detector's own jitter), otherwise the frames before
  // it (selfDrift). Left in the picture is the robot's left (a higher yaw, as selfScan).
  const selfSide=()=>{const last=selfLast?selfLast.x-.5:0,way=Math.abs(last)>=SELF_DRIFT?last:selfDriftX;return way<=-SELF_DRIFT?1:way>=SELF_DRIFT?-1:0;};
  // mod.js: a conversation is opening (held) or ready again. selfComing: following alone is about to take the camera,
  // and will send the video itself.
  const videoSync=async selfComing=>{
    if(videoHeld){if(cameraMode==='video')await stopCamera();return;}
    if(videoWanted&&!closed&&!cameraActive&&!selfComing){await startCamera('video');if(videoJpeg&&!videoStats)videoStats={frames:0,bytes:0,most:0,ms:0,waited:0,at:Time.ticks};}
  };
  return {connect,close,hello,snapshot,self,selfWake,videoSync,get selfHelped(){return selfHelped;},set videoHeld(value){videoHeld=!!value;},get videoOn(){return videoWanted;},get calling(){return !!microphone||!!speaker;},get selfSide(){return selfSide();},
    // The body has turned under the head (mod.js, a turn of following with the rover) and the head has been told to
    // turn back by `delta` radians: every direction remembered here is counted from the body, so it moves by as much.
    // Without this the face is looked for where it no longer is, and the turn looks like a face running sideways
    // (SELF_LEAD would aim ahead of it).
    selfTurned(delta){if(!Number.isFinite(delta))return;if(selfFace)selfFace.yaw+=delta;if(selfHome)selfHome.yaw+=delta;if(selfTrack)selfTrack.yaw+=delta;},get selfActive(){return cameraActive&&cameraMode==='self';},get selfAvailable(){return !!finder&&selfOn();},get selfSeenMs(){return selfSeenAt===undefined?Infinity:Time.delta(selfSeenAt);},
    get selfAloneMs(){if(!cameraActive||cameraMode!=='self')return 0;const found=selfFoundAt===undefined?Infinity:Time.delta(selfFoundAt),looking=selfLookFrom===undefined?Infinity:Time.delta(selfLookFrom),alone=Math.min(found,looking);return Number.isFinite(alone)&&alone>0?alone:0;},busy:()=>cameraSwitching>0};
}
