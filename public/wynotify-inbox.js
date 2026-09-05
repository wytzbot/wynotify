/* WyNotify notification inbox widget. Add data-workspace-key and data-api to the script tag. */
(function(){
  "use strict";
  const script=document.currentScript;if(!script)return;
  const key=script.dataset.workspaceKey||"";
  const api=(script.dataset.api||new URL("/api",script.src).href).replace(/\/$/,"");
  const target=script.dataset.target||"";
  if(!key){console.warn("WyNotify inbox: add data-workspace-key.");return;}
  const mount=()=>{
    const root=target?document.querySelector(target):document.createElement("div");
    if(!root)return;
    if(!target){root.className="wynotify-inbox";document.body.appendChild(root);}
    root.innerHTML="<div style=\"font:600 15px system-ui;padding:14px;border:1px solid #0002;border-radius:12px\">Loading notifications…</div>";
    fetch(api+"?action=inbox&workspaceKey="+encodeURIComponent(key),{credentials:"omit"})
      .then(r=>r.json().then(d=>({ok:r.ok,d}))).then(({ok,d})=>{
        if(!ok)throw new Error(d.error||"Could not load notifications.");
        const items=d.items||[];
        root.innerHTML="";
        const box=document.createElement("div");box.style.cssText="font:14px/1.45 system-ui,-apple-system,sans-serif;border:1px solid #0002;border-radius:14px;overflow:hidden;background:#fff;color:#111827";
        const head=document.createElement("div");head.style.cssText="padding:14px 16px;font-weight:700;border-bottom:1px solid #0001";head.textContent="Recent updates";box.appendChild(head);
        if(!items.length){const empty=document.createElement("div");empty.style.padding="18px 16px";empty.textContent="No recent notifications.";box.appendChild(empty);}
        items.forEach(x=>{const a=document.createElement("a");a.href=x.url||"/";a.style.cssText="display:block;padding:14px 16px;text-decoration:none;color:inherit;border-bottom:1px solid #0001";const t=document.createElement("div");t.style.fontWeight="700";t.textContent=x.title||"Update";const m=document.createElement("div");m.style.opacity=".72";m.textContent=x.message||"";a.append(t,m);box.appendChild(a);});
        root.appendChild(box);
      }).catch(e=>{root.innerHTML="<div style=\"font:14px system-ui;padding:14px;border:1px solid #0002;border-radius:12px\">"+(e.message||"Could not load notifications.")+"</div>";});
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();
})();
