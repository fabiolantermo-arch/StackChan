// Two Wi-Fi networks (home and iPhone hotspot) on a host that stores only one.
// While Settings is open the MOD remembers every network written over Bluetooth: the newest
// becomes the main one, the previous one the spare. Before each boot connection it scans and
// puts the visible network into the host's single slot (main first). Passwords never leave the robot.
const KEYS=[['net0ssid','net0pass'],['net1ssid','net1pass']];
const valid=n=>!!n&&typeof n.ssid==='string'&&n.ssid.length>0&&n.ssid.length<=32&&typeof n.password==='string'&&n.password.length>0&&n.password.length<=64;

export function loadNetworks(preference){
  const list=[];
  for(const [s,p] of KEYS){const item={ssid:preference.get('robottino',s),password:preference.get('robottino',p)};if(valid(item))list.push(item);}
  return list;
}
export function saveNetworks(preference,list){
  KEYS.forEach(([s,p],i)=>{
    const item=list[i];
    if(item){preference.set('robottino',s,item.ssid);preference.set('robottino',p,item.password);}
    else{try{preference.delete('robottino',s);preference.delete('robottino',p);}catch{}}
  });
}
/** The newest written network becomes the main one; at most two are kept. */
export function learnNetwork(list,written){
  if(!valid(written))return list;
  return [{ssid:written.ssid,password:written.password},...list.filter(n=>n.ssid!==written.ssid)].slice(0,2);
}
/** The main network if visible, else the spare; null keeps whatever the host has. */
export function chooseNetwork(list,visible){
  const seen=new Set(visible);
  return list.find(n=>seen.has(n.ssid))??null;
}
/** SSIDs seen by one scan; resolves with what was found on timeout or error. */
export function scanSSIDs(scan,{timeoutMs=6000,timer}){
  return new Promise(resolve=>{
    const found=new Set();let done=false,session,id;
    const finish=()=>{if(done)return;done=true;if(id!==undefined)timer.clear(id);try{session?.close?.();}catch{}resolve([...found]);};
    id=timer.set(finish,timeoutMs);
    try{
      session=scan({onFound(item){const ssid=item?.ssid??item?.SSID;if(!done&&typeof ssid==='string'&&ssid&&found.size<64)found.add(ssid);},onComplete:finish,onError:finish});
      if(done)session?.close?.();
    }catch{finish();}
  });
}
/**
 * Wraps the host's own launch step (splash, Settings, MOD manager): it runs unchanged, and
 * networks written meanwhile are learned. Then the visible network goes into the host slot.
 */
export async function launchWithNetworks({hostLaunch,preference,timer,scan,log=()=>{}}){
  const read=()=>({ssid:preference.get('wifi','ssid'),password:preference.get('wifi','password')});
  let networks=loadNetworks(preference),last=read();
  // A robot configured before this MOD already has one network: keep it as the main one.
  if(!networks.length&&valid(last)){networks=learnNetwork(networks,last);saveNetworks(preference,networks);}
  const learn=()=>{
    const now=read();if(now.ssid===last.ssid&&now.password===last.password)return;
    last=now;if(!valid(now))return;
    networks=learnNetwork(networks,now);saveNetworks(preference,networks);log('learned');
  };
  const poll=timer.repeat(learn,300);
  let launch;
  try{launch=await hostLaunch();}finally{timer.clear(poll);learn();}
  if(launch===false||networks.length<2||!scan)return launch;
  const chosen=chooseNetwork(networks,await scanSSIDs(scan,{timer}));
  const current=read();
  if(chosen&&(chosen.ssid!==current.ssid||chosen.password!==current.password)){
    preference.set('wifi','ssid',chosen.ssid);preference.set('wifi','password',chosen.password);last=read();log('switched');
  }
  return launch;
}
