// Original deterministic canvas sculpture. Every visible position depends only on
// timeline time, so reversing time really reverses every fragment's trajectory.
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const sub = (a, b) => a.map((x, i) => x - b[i]);
let seed = 19317;
function random() { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }
function rotate(v, y, x) {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y);
  const vx = v[0]*cy + v[2]*sy, vz = -v[0]*sy + v[2]*cy;
  return [vx, v[1]*cx-vz*sx, v[1]*sx+vz*cx];
}
function mesh() {
  const p = (1 + Math.sqrt(5)) / 2;
  const vertices = [[-1,p,0],[1,p,0],[-1,-p,0],[1,-p,0],[0,-1,p],[0,1,p],[0,-1,-p],[0,1,-p],[p,0,-1],[p,0,1],[-p,0,-1],[-p,0,1]].map(unit);
  let faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]].map(f => f.map(i => vertices[i]));
  for(let s=0;s<3;s++){
    faces = faces.flatMap(([a,b,c]) => {
      const ab=unit(a.map((v,i)=>v+b[i])),bc=unit(b.map((v,i)=>v+c[i])),ca=unit(c.map((v,i)=>v+a[i]));
      return [[a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]];
    });
  }
  return faces.map(points => ({points, center:points[0].map((_,i)=>(points[0][i]+points[1][i]+points[2][i])/3), drift:random(), spin:random()*2-1, shade:random()}));
}
const faces = mesh();
const dust = Array.from({length:330},()=>({x:random(),y:random(),r:random(),a:random(),z:random()}));
const light = unit([-.6,-.8,1]);

export class Sculpture {
  constructor(canvas) { this.canvas=canvas; this.ctx=canvas.getContext('2d'); }
  draw(time, mode='bloom', pixelRatio=Math.min(devicePixelRatio || 1,2)) {
    const canvas=this.canvas, ctx=this.ctx;
    const w=canvas.clientWidth || 960, h=canvas.clientHeight || 540;
    if(canvas.width!==Math.round(w*pixelRatio)||canvas.height!==Math.round(h*pixelRatio)) {canvas.width=Math.round(w*pixelRatio);canvas.height=Math.round(h*pixelRatio);}
    ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);
    const bg=ctx.createRadialGradient(w*.51,h*.4,0,w*.5,h*.45,w*.75);
    bg.addColorStop(0,'#283326');bg.addColorStop(.47,'#172017');bg.addColorStop(1,'#0c120f');
    ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    const glow=ctx.createRadialGradient(w*.53,h*.44,0,w*.53,h*.44,h*.5);
    glow.addColorStop(0,'#bf9a4d08');glow.addColorStop(1,'#b4a97c00');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
    for(const d of dust){ctx.fillStyle=`rgba(184,197,157,${.07+d.a*.17})`;ctx.beginPath();ctx.arc(d.x*w,d.y*h,d.r*.8+.15,0,TAU);ctx.fill();}
    const cx=w*.51, cy=h*.46, scale=Math.min(w*.19,h*.245);
    ctx.save();ctx.translate(cx,h*.77);ctx.scale(1,.15);
    const shadow=ctx.createRadialGradient(0,0,5,0,0,scale*1.3);shadow.addColorStop(0,'#020704a0');shadow.addColorStop(1,'#02070400');
    ctx.fillStyle=shadow;ctx.beginPath();ctx.arc(0,0,scale*1.3,0,TAU);ctx.fill();ctx.restore();
    if(mode==='orbit') this.orbit(ctx,time,cx,cy,scale); else this.bloom(ctx,time,cx,cy,scale);
    // Quiet measurement marks anchor the object in space.
    ctx.strokeStyle='#83906c20';ctx.lineWidth=.7;
    for(const side of [-1,1]){const x=cx+side*Math.min(w*.31,h*.52);ctx.beginPath();ctx.moveTo(x,cy-7);ctx.lineTo(x,cy+7);ctx.moveTo(x-3,cy);ctx.lineTo(x+3,cy);ctx.stroke();}
  }
  bloom(ctx,time,cx,cy,scale){
    const t=clamp(time,0,1), opening=t*t*(3-2*t), angle=.35+t*.55;
    const project=v=>{const perspective=4.8/(4.8-v[2]);return[cx+v[0]*scale*perspective,cy+v[1]*scale*perspective];};
    const polygons=faces.map(f=>{
      const c=f.center;
      const expand=opening*(.25+f.drift*1.5);
      const center=c.map((v,i)=>v*(1+expand)+(i===1?opening*opening*(f.drift-.5)*.2:0));
      const points=f.points.map(p=>{
        let q=sub(p,c);q=rotate(q,f.spin*opening*3,f.spin*opening*1.5);
        return rotate(q.map((v,i)=>v*(1-opening*.12)+center[i]),angle,-.19);
      });
      const normal=unit(cross(sub(points[1],points[0]),sub(points[2],points[0])));
      const brightness=Math.max(0,normal.reduce((sum,v,i)=>sum+v*light[i],0));
      return {points,z:points.reduce((s,v)=>s+v[2],0)/3,brightness,shade:f.shade,normal};
    }).sort((a,b)=>a.z-b.z);
    for(const f of polygons){
      const p=f.points.map(project), back=f.normal[2]<0;
      const b=.23+f.brightness*.7+f.shade*.08;
      const r=back?72+f.shade*20:119+132*b,g=back?62+f.shade*16:64+120*b,bl=back?43+f.shade*12:37+99*b;
      ctx.fillStyle=`rgb(${r|0},${g|0},${bl|0})`;ctx.beginPath();ctx.moveTo(...p[0]);ctx.lineTo(...p[1]);ctx.lineTo(...p[2]);ctx.closePath();ctx.fill();
      ctx.strokeStyle=`rgba(255,220,165,${.035+f.brightness*.1})`;ctx.lineWidth=.45;ctx.stroke();
    }
    // Spark fragments follow the same reversible timeline.
    if(opening>.12){for(let i=0;i<110;i++){const d=dust[i],theta=d.a*TAU+t*d.z*.6;const rad=1.25+opening*(.3+d.r*1.5);const v=rotate([Math.cos(theta)*rad,Math.sin(theta)*rad*(.6+d.z*.3),(d.x-.5)*2],.1,-.2);const p=project(v);ctx.fillStyle=`rgba(223,183,125,${opening*(.1+d.z*.45)})`;ctx.fillRect(p[0],p[1],.7+d.r,.7+d.r);}}
  }
  orbit(ctx,time,cx,cy,scale){
    const points=[];
    for(let band=0;band<7;band++)for(let j=0;j<200;j++){
      const a=j/200*TAU+time*TAU*(.35+band*.12),r=.45+band*.16;
      const v=rotate([Math.cos(a)*r,Math.sin(a)*r,Math.sin(a*3+time*TAU)*(time*.25+.08)],.35+time*.7,(band-3)*.19+.5);
      points.push({v,band,j});
    }
    points.sort((a,b)=>a.v[2]-b.v[2]);
    for(const {v,band,j} of points){const p=4.5/(4.5-v[2]);ctx.fillStyle=band%2?`rgba(212,230,151,${.3+(v[2]+1.4)*.18})`:`rgba(234,172,120,${.3+(v[2]+1.4)*.18})`;ctx.beginPath();ctx.arc(cx+v[0]*scale*p,cy+v[1]*scale*p,(j%5===0?2.1:1.1)*p,0,TAU);ctx.fill();}
  }
}
