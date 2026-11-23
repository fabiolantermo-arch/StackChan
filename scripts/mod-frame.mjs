// How many JavaScript stack slots the MOD's main function (startRobottino in mod.js) needs when it is called.
// XS makes the whole frame at the call: one slot for each name of the function's own top level, and one for each
// name of the module around it (imports, top-level declarations) that it or a function inside it uses («retrieved»).
// The robot's stack is 768 slots (the host's creation.stack): the frame, plus what the host has on the stack when it
// calls the MOD, plus the deepest call made from the function's body (the face: Piu container, behaviour), must fit.
// 21 Nov 2026, measured on the robot with this count: at 446 it started, at 447 it stopped at every start
// («stack overflow (-1)!», XS abort while the face was being made).
// Use: node scripts/mod-frame.mjs [file or git ref of mod.js …]
import {parseAst} from 'rollup/parseAst';
import {execSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
const bind=(p,set)=>{if(!p)return;if(p.type==='Identifier')set.add(p.name);else if(p.type==='ObjectPattern')p.properties.forEach(q=>bind(q.value??q.argument,set));else if(p.type==='ArrayPattern')p.elements.forEach(q=>bind(q,set));else if(p.type==='AssignmentPattern')bind(p.left,set);else if(p.type==='RestElement')bind(p.argument,set);};
export function measure(src,name='startRobottino'){
  const ast=parseAst(src),moduleNames=new Set();let main;
  for(const st of ast.body){
    const node=st.type==='ExportNamedDeclaration'&&st.declaration?st.declaration:st;
    if(node.type==='ImportDeclaration')node.specifiers.forEach(s=>moduleNames.add(s.local.name));
    else if(node.type==='VariableDeclaration')node.declarations.forEach(d=>bind(d.id,moduleNames));
    else if(node.type==='FunctionDeclaration'||node.type==='ClassDeclaration'){moduleNames.add(node.id.name);if(node.id.name===name)main=node;}
  }
  if(!main)throw Error('no '+name);
  const top=new Set();main.params.forEach(p=>bind(p,top));
  for(const st of main.body.body){if(st.type==='VariableDeclaration')st.declarations.forEach(d=>bind(d.id,top));else if(st.type==='FunctionDeclaration'||st.type==='ClassDeclaration')top.add(st.id.name);}
  const used=new Set();
  const visit=(n,parent,key)=>{
    if(!n||typeof n.type!=='string')return;
    if(n.type==='Identifier'){
      const property=(parent.type==='MemberExpression'&&key==='property'&&!parent.computed)||((parent.type==='Property'||parent.type==='MethodDefinition'||parent.type==='PropertyDefinition')&&key==='key'&&!parent.computed);
      if(!property&&moduleNames.has(n.name)&&!top.has(n.name))used.add(n.name);
      return;
    }
    for(const k in n){const v=n[k];if(Array.isArray(v))v.forEach(x=>visit(x,n,k));else if(v&&typeof v.type==='string')visit(v,n,k);}
  };
  visit(main.body,main,'body');
  return {own:top.size,module:used.size,frame:top.size+used.size,usedModuleNames:[...used].sort()};
}
if(process.argv[1]?.endsWith('mod-frame.mjs')){
  const targets=process.argv.slice(2);if(!targets.length)targets.push('firmware/stackchan-mod/mod.js');
  for(const t of targets){
    const src=existsSync(t)?readFileSync(t,'utf8'):execSync(`git show ${t}:firmware/stackchan-mod/mod.js`,{maxBuffer:1e8}).toString();
    const m=measure(src);console.log(`${t.padEnd(44)} nomi propri ${m.own}  nomi del modulo usati ${m.module}  totale ${m.frame}`);
  }
}
