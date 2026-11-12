const $=id=>document.getElementById(id);
let teams=[],players=[],available=[],activePlayer=null,activeIndex=0,currentBid=0,currentBidTeam="";
const socket=io();
socket.on("auction:update",async()=>{await loadTeams();loadPlayers();loadStats();loadUnsold();loadHistory();loadLatestTeamSnapshot();});
socket.on("auction:bid",b=>{if(activePlayer&&b.player_id===activePlayer.id){currentBid=b.amount;currentBidTeam=b.team;$("currentBid").textContent=b.amount.toFixed(2);$("currentBidTeam").textContent=b.team;$("currentBid").classList.add("bid-value-updated");resetBidCountdown();playAuctionTone("bid");publishBroadcastState("AUCTION LIVE",activePlayer.name,`Current bid ₹${Number(b.amount).toFixed(2)} Cr · ${b.team}`);}});
let messageTimer=null;
function toast(msg,type="error"){
  const overlay=$("messageOverlay");
  if(!overlay){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2800);return;}
  $("messageIcon").textContent=type==="success"?"✓":"✕";
  $("messageTitle").textContent=type==="success"?"SUCCESS":"PLEASE CHECK";
  $("messageText").textContent=String(msg||"Something went wrong");
  overlay.classList.add("show");clearTimeout(messageTimer);messageTimer=setTimeout(closeMessage,3000);
}
function closeMessage(){const el=$("messageOverlay");if(el)el.classList.remove("show");clearTimeout(messageTimer)}
async function api(url,opts={}){const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
function page(name){document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));$("page-"+name).classList.add("active");document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n.dataset.page===name));$("pageTitle").textContent=({dashboard:"Dashboard",auction:"Live Auction",players:"Player Database",teams:"Teams & Squads",unsold:"Unsold Players",sold:"Sold Players",trades:"Player Trade",import:"Excel Import",history:"Auction History",retention:"Retention & Release",squad:"Squad Builder",analytics:"Auction Statistics",broadcast:"Live Broadcast",tools:"Auction Tools",nomination:"Nomination Center",analyzer:"Playing XI Analyzer",tournament:"Tournament Center"})[name];if(name==="auction")loadAuction();if(name==="players")loadPlayers();if(name==="teams")renderTeamsPage();if(name==="unsold")loadUnsold();if(name==="sold")loadSold();if(name==="trades")fillTradeSelects();if(name==="history")loadHistory();if(name==="retention")loadRetention();if(name==="squad")loadSquadBuilder();if(name==="analytics")loadAnalytics();if(name==="nomination")loadNominationQueue();if(name==="analyzer")loadXIAnalyzer();if(name==="tournament")loadTournamentCenter()}
document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>page(n.dataset.page)));
async function loadTeams(){try{teams=await api("/api/teams");renderTeamCards();fillTeamSelects();renderTeamsPage();["xiTeamSelect"].forEach(id=>{const el=$(id);if(el)el.innerHTML='<option value="">Select team</option>'+teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("")})}catch(e){toast(e.message)}}

function teamLogoMarkup(team,cls="team-logo"){
  if(!team)return "";
  const raw=String(team.short_name||team.name||"").trim().toUpperCase().replace(/\s+/g,"");
  const key=raw.replace(/[²^]/g,"2");
  const aliases={
    SS:"ss", DCS:"dcs", BCS:"dcs", BR:"br", "7SV":"7sv", "7SB":"7sv", "7S":"7sv",
    KD2:"kd2", "KDSQUARE":"kd2", ARC:"arc", KCG:"kcg", RH:"rh", CC:"cc",
    BBC:"bbc", FCK:"fck", VTK:"vtk", AKS:"aks", TG:"tg"
  };
  const code=aliases[key]||aliases[raw];
  if(code)return `<img class="${cls}" src="/assets/team-${code}.webp" alt="${esc(team.name||raw)} logo" loading="lazy" onerror="this.outerHTML='<span class=\"${cls} team-logo-fallback\">${esc(raw.slice(0,3)||'TEAM')}</span>'">`;
  if(team.logo_url)return `<img class="${cls}" src="${esc(team.logo_url)}" alt="${esc(team.name)} logo" loading="lazy">`;
  return `<span class="${cls} team-logo-fallback">${esc(raw.slice(0,3)||"TEAM")}</span>`;
}
function announceConfirm(title,html,okLabel="✓ OK · CONFIRM SOLD"){
  return new Promise(resolve=>{
    const overlay=$("auctionConfirmOverlay"),titleEl=$("auctionConfirmTitle"),textEl=$("auctionConfirmText"),ok=$("auctionConfirmOk"),cancel=$("auctionConfirmCancel");
    titleEl.textContent=title;textEl.innerHTML=html;ok.textContent=okLabel;const stamp=overlay.querySelector(".confirm-stamp");if(stamp)stamp.textContent=okLabel.includes("UNSOLD")?"UNSOLD":okLabel.includes("RTM")?"RTM":"SOLD";overlay.classList.add("show");overlay.setAttribute("aria-hidden","false");
    const finish=value=>{overlay.classList.remove("show");overlay.setAttribute("aria-hidden","true");ok.removeEventListener("click",yes);cancel.removeEventListener("click",no);resolve(value)};
    const yes=()=>finish(true),no=()=>finish(false);
    ok.addEventListener("click",yes);cancel.addEventListener("click",no);
  });
}

function renderTeamCards(){const html=teams.map(t=>{const pct=Math.max(0,Math.min(100,(t.remaining_purse/90)*100));return `<div class="team-card"><div class="team-card-head"><div class="team-title-with-logo">${teamLogoMarkup(t)}<h4>${esc(t.name)}</h4></div><span class="count">${t.squad_size}/20</span></div><div class="purse">₹${Number(t.remaining_purse).toFixed(2)} Cr</div><div class="muted">Remaining purse · Spent ₹${Number(t.spent).toFixed(2)} Cr</div><div class="progress"><span style="width:${pct}%"></span></div><div class="mini-stats"><span>🇮🇳 <b>${t.indian_count}/9</b></span><span>🌍 <b>${t.effective_overseas}/9</b></span><span>🧩 <b>${t.associate_count}/2</b></span><span>RTM <b>${t.indian_rtm}+${t.overseas_rtm}</b></span></div><button class="btn btn-outline" style="margin-top:14px" onclick="viewSquad(${t.id},'${esc(t.name)}')">View Squad</button></div>`}).join("")||'<div class="empty">No teams yet. Add your franchises to begin.</div>';$("teamOverview").innerHTML=html}
function renderTeamsPage(){$("teamsPageGrid").innerHTML=teams.map(t=>`<div class="team-card"><div class="team-card-head"><div class="team-title-with-logo">${teamLogoMarkup(t)}<h4>${esc(t.name)}</h4></div><span class="count">${t.squad_size}/20 Players</span></div><div class="purse">₹${Number(t.remaining_purse).toFixed(2)} Cr</div><div class="mini-stats"><span>Indian ${t.indian_count}/9</span><span>Overseas slots ${t.effective_overseas}/9</span><span>Associate ${t.associate_count}/2</span></div><div class="mini-stats" style="margin-top:10px"><span>Indian RTM: ${t.indian_rtm}</span><span>Overseas/Associate RTM: ${t.overseas_rtm}</span></div><button class="btn btn-outline" style="margin-top:14px" onclick="viewSquad(${t.id},'${esc(t.name)}')">Open Squad</button></div>`).join("")||'<div class="empty">No teams created.</div>'}
async function viewSquad(id,name){try{const rows=await api("/api/squad/"+id);$("modalContent").innerHTML=`<h3>${esc(name)} – Squad</h3><p class="muted">${rows.length} players · Amounts in ₹ Crore</p><div class="table-wrap"><table><thead><tr><th>PLAYER</th><th>CATEGORY</th><th>ROLE</th><th>TYPE</th><th>PRICE</th></tr></thead><tbody>${rows.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.category}</td><td>${esc(p.role)}</td><td>${p.acquisition_type}</td><td>${Number(p.amount).toFixed(2)}</td></tr>`).join("")}</tbody></table></div>`;openModal()}catch(e){toast(e.message)}}
async function loadStats(){try{const s=await api("/api/stats");$("statTotal").textContent=s.total||0;$("statAvailable").textContent=s.available||0;$("statSold").textContent=(Number(s.sold)||0)+(Number(s.retained)||0);$("statUnsold").textContent=s.unsold||0}catch(e){}}
async function loadPlayers(){try{const q=new URLSearchParams({search:$("playerSearch")?.value||"",category:$("playerCategory")?.value||"",role:$("playerRole")?.value||"",status:$("playerStatus")?.value||""});players=await api("/api/players?"+q);$("playersTable").innerHTML=players.map(p=>`<tr><td><b>${esc(p.name)}</b><div class="muted">${esc(p.country||"")}</div></td><td>${p.category}</td><td>${esc(p.role)}</td><td>${esc(p.previous_team||"—")}</td><td>₹${Number(p.previous_price||0).toFixed(2)} Cr</td><td><span class="status ${p.status}">${p.status}</span></td></tr>`).join("")||'<tr><td colspan="6" class="empty">No players found.</td></tr>'}catch(e){toast(e.message)}}
function fillTeamSelects(){const opts=teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");["bidTeam","tradeFrom","tradeTo"].forEach(id=>{if($(id))$(id).innerHTML='<option value="">Select team</option>'+opts})}
async function loadAuction(){available=await api("/api/players?status=AVAILABLE");$("availableCount").textContent=available.length;renderAuctionList();if(!activePlayer&&available.length)selectPlayer(available[0].id);await loadLatestTeamSnapshot()}
function renderAuctionList(){const q=($("auctionSearch").value||"").toLowerCase();const cat=$("auctionCategoryFilter")?.value||"",role=$("auctionRoleFilter")?.value||"";const list=available.filter(p=>p.name.toLowerCase().includes(q)&&(!cat||p.category===cat)&&(!role||p.role===role));$("auctionList").innerHTML=list.map(p=>`<div class="player-row" onclick="selectPlayer(${p.id})"><div><b>${esc(p.name)}</b><small>${p.category} · ${esc(p.role)}</small></div><button>SELECT</button></div>`).join("")||'<div class="empty">No available players.</div>'}
function setPlayerPhoto(p){
  const host=$("playerAvatar");
  if(p.photo_url){
    host.innerHTML=`<img src="${esc(p.photo_url)}" alt="${esc(p.name)}" onerror="this.remove();this.parentElement.innerHTML='<span>🏏</span>'">`;
  } else {
    const initials=String(p.name||"").split(/\\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();
    host.innerHTML=`<span class="player-initials">${esc(initials||"🏏")}</span>`;
  }
}
async function loadLatestTeamSnapshot(){
  try{
    const latest=await api("/api/latest-team");
    if(!latest){$("selectedTeamInfo").textContent="No player has been bought yet.";return;}
    const t=teams.find(x=>Number(x.id)===Number(latest.id));
    if(!t){$("selectedTeamInfo").textContent=latest.name+" — refresh team data.";return;}
    $("selectedTeamInfo").innerHTML=`<div class="latest-team-name">${teamLogoMarkup(t,"team-logo latest-team-logo")} ${esc(t.name)}</div><div class="purse">₹${Number(t.remaining_purse).toFixed(2)} Cr</div><p class="muted">Remaining purse · Spent ₹${Number(t.spent).toFixed(2)} Cr</p><p class="muted">Squad: ${t.squad_size}/20</p><p class="muted">Indian: ${t.indian_count}/9 · Overseas slots: ${t.effective_overseas}/9</p><p class="muted">Associate: ${t.associate_count} (first 2 dedicated)</p><p class="muted">RTM: ${t.indian_rtm} Indian + ${t.overseas_rtm} Overseas/Associate</p>`;
  }catch(e){}
}
function showAuctionOutcome(kind, playerName, teamName, amount){
  const host=$("playerAvatar");
  host.classList.remove("outcome-sold","outcome-unsold");
  void host.offsetWidth;
  host.classList.add(kind==="UNSOLD"?"outcome-unsold":"outcome-sold");
  const old=document.querySelector(".auction-result-banner"); if(old)old.remove();
  const banner=document.createElement("div");banner.className="auction-result-banner "+(kind==="UNSOLD"?"unsold-banner":"sold-banner");
  const resultTeam=teams.find(t=>t.name===teamName);
  const resultMarkup=kind==="RTM"
    ? `<strong>✓ RTM CONFIRMED</strong><span>${esc(playerName)}</span><div class="result-team">${teamLogoMarkup(resultTeam,"result-team-logo")}<b>RTM BY ${esc(resultTeam?.short_name||teamName||"TEAM")}</b></div><span>₹${Number(amount||0).toFixed(2)} Cr</span>`
    : kind==="SOLD"
      ? `<strong>✓ SOLD</strong><span>${esc(playerName)}</span><div class="result-team">${teamLogoMarkup(resultTeam,"result-team-logo")}<b>SOLD TO ${esc(resultTeam?.short_name||teamName||"TEAM")}</b></div><span>₹${Number(amount||0).toFixed(2)} Cr</span>`
      : `<strong>✕ UNSOLD</strong><span>${esc(playerName)} returns to the pool</span>`;
  banner.innerHTML=`<div class="result-auctioneer"><img src="/assets/snk-auctioneer.jpg" alt="Auctioneer announcing the result"><span class="gavel-strike">🔨</span></div>${resultMarkup}`;
  host.parentElement.insertBefore(banner,host.nextSibling);
  setTimeout(()=>{banner.classList.add("fade-away");},1250);
}
function selectPlayer(id){activeIndex=available.findIndex(p=>p.id===id);activePlayer=available[activeIndex];if(!activePlayer)return;setPlayerPhoto(activePlayer);document.querySelector(".auction-result-banner")?.remove();currentBid=Number(activePlayer.base_price||.5);currentBidTeam="";$("auctionPlayerName").textContent=activePlayer.name;$("auctionPlayerName").title="Click to view player profile";$("auctionPlayerName").onclick=()=>showPlayerProfile(activePlayer.id);$("auctionCategory").textContent=activePlayer.category;$("auctionRole").textContent=activePlayer.role;$("auctionPreviousTeam").textContent=activePlayer.previous_team||"—";$("auctionPreviousPrice").textContent="₹"+Number(activePlayer.previous_price||0).toFixed(2)+" Cr";$("auctionBasePrice").textContent="₹"+currentBid.toFixed(2)+" Cr";$("currentBid").textContent=currentBid.toFixed(2);$("currentBidTeam").textContent="Base price";$("bidAmount").value=currentBid.toFixed(2);$("auctionIndex").textContent=`LOT ${activeIndex+1} / ${available.length}`;$("selectedTeamInfo").textContent="Select a team to view purse and slots.";updateBroadcast("AUCTION LIVE",activePlayer.name,`${activePlayer.category} · ${activePlayer.role} · Base ₹${currentBid.toFixed(2)} Cr`);resetBidCountdown()}
function nextPlayer(){if(!available.length)return;selectPlayer(available[(activeIndex+1)%available.length].id)}
function previousPlayer(){if(!available.length)return;selectPlayer(available[(activeIndex-1+available.length)%available.length].id)}
function incrementBid(n){const v=Number($("bidAmount").value||currentBid)+n;$("bidAmount").value=v.toFixed(2);$("currentBid").textContent=v.toFixed(2);$("currentBid").classList.add("bid-value-updated");setTimeout(()=>$("currentBid")?.classList.remove("bid-value-updated"),350)}
$("bidTeam").addEventListener("change",()=>{});
$("bidAmount").addEventListener("input",()=>{const v=Number($("bidAmount").value);if(Number.isFinite(v)&&v>0){$("currentBid").textContent=v.toFixed(2);$("currentBid").classList.add("bid-value-updated");}});
async function placeBid(){if(auctionPaused)throw new Error("Auction is paused");if(!activePlayer)throw new Error("Select a player");const team_id=$("bidTeam").value,amount=Number($("bidAmount").value);if(!team_id||!amount)throw new Error("Select a team and enter a bid");if(amount<=currentBid)throw new Error("Bid must be higher than current bid");await api("/api/bid",{method:"POST",body:JSON.stringify({player_id:activePlayer.id,team_id,amount})});currentBid=amount;currentBidTeam=teams.find(t=>t.id==team_id)?.name||"";$("currentBid").textContent=amount.toFixed(2);$("currentBidTeam").textContent=currentBidTeam;resetBidCountdown();playAuctionTone("bid");toast("Bid recorded")}
async function sellPlayer(){try{if(auctionPaused)throw new Error("Resume auction before marking a player SOLD");if(!activePlayer)throw new Error("Select a player");const team_id=$("bidTeam").value,amount=Number($("bidAmount").value);if(!team_id||!amount)throw new Error("Select winning team and final amount");const soldTeamObj=teams.find(t=>Number(t.id)===Number(team_id));const soldTeam=soldTeamObj?.name||"Team";const soldLogo=teamLogoMarkup(soldTeamObj,"confirm-team-logo");if(!await announceConfirm("Confirm player sale?",`<b>${esc(activePlayer.name)}</b><br>Sold to <b>${esc(soldTeam)}</b><br>Final price: <b>₹${amount.toFixed(2)} Cr</b><div class="confirm-team">${soldLogo}<span>${esc(soldTeam)}</span></div>`))return;const soldName=activePlayer.name;await api("/api/sold",{method:"POST",body:JSON.stringify({player_id:activePlayer.id,team_id,amount})});toast("Player sold successfully","success");playAuctionTone("sold");activePlayer=null;await refreshAll();await loadAuction();showAuctionOutcome("SOLD",soldName,soldTeam,amount);updateBroadcast("SOLD",soldName,`${soldTeam} · ₹${Number(amount).toFixed(2)} Cr`);publishBroadcastState("SOLD",soldName,`${soldTeam} · ₹${Number(amount).toFixed(2)} Cr`,soldTeamObj?.short_name||"",amount)}catch(e){toast(e.message)}}
async function markUnsold(){try{if(auctionPaused)throw new Error("Resume auction before marking a player UNSOLD");if(!activePlayer)throw new Error("Select a player");if(!await announceConfirm("Confirm unsold result?",`<b>${esc(activePlayer.name)}</b><br>This player will return to the unsold pool.`,"✓ OK · CONFIRM UNSOLD"))return;const unsoldName=activePlayer.name;await api("/api/unsold",{method:"POST",body:JSON.stringify({player_id:activePlayer.id})});toast("Player moved to unsold list","success");playAuctionTone("unsold");activePlayer=null;await refreshAll();await loadAuction();showAuctionOutcome("UNSOLD",unsoldName,"","");updateBroadcast("UNSOLD",unsoldName,"Returned to player pool")}catch(e){toast(e.message)}}
async function rtmPlayer(){try{
  if(auctionPaused)throw new Error("Resume auction before using RTM");if(!activePlayer)throw new Error("Select a player");
  const team_id=$("bidTeam").value,amount=Number($("bidAmount").value),team=teams.find(t=>Number(t.id)===Number(team_id));
  if(!team_id)throw new Error("Select the previous team in the team selector");
  if(!await announceConfirm("Confirm Right To Match?",`<b>${esc(activePlayer.name)}</b><br>RTM by <b>${esc(team?.name||"")}</b><br>Final price: <b>₹${amount.toFixed(2)} Cr</b><div class="confirm-team">${teamLogoMarkup(team,"confirm-team-logo")}<span>${esc(team?.name||"")}</span></div>`,"✓ CONFIRM RTM"))return;
  const name=activePlayer.name;await api("/api/rtm",{method:"POST",body:JSON.stringify({player_id:activePlayer.id,team_id,amount})});playAuctionTone("sold");activePlayer=null;await refreshAll();await loadAuction();showAuctionOutcome("RTM",name,team?.name||"",amount);updateBroadcast("RTM",name,`RTM by ${team?.name} · ₹${amount.toFixed(2)} Cr`);publishBroadcastState("RTM",name,`RTM by ${team?.name} · ₹${amount.toFixed(2)} Cr`,team?.short_name||"",amount);toast(`${name} retained by RTM – ${team?.name}`,"success");
}catch(e){toast(e.message)}}

async function loadRetention(){
  try{
    const poolPlayers=await api("/api/players?status=AVAILABLE");
    $("retentionTeam").innerHTML='<option value="">Select previous team first</option>'+teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");
    const fillEligible=()=>{const team=teams.find(t=>Number(t.id)===Number($("retentionTeam").value));const eligible=team?poolPlayers.filter(p=>String(p.previous_team||"").trim().toLowerCase()===team.name.trim().toLowerCase()):[];$("retentionPlayer").innerHTML='<option value="">Select player</option>'+eligible.map(p=>`<option value="${p.id}">${esc(p.name)} (${p.category})</option>`).join("");};
    $("retentionTeam").onchange=fillEligible;fillEligible();
    const retained=await api("/api/players?status=RETAINED");
    $("retainedTable").innerHTML=retained.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.current_team||"—")}</td><td>${p.category}</td><td>₹${Number(p.sold_price||0).toFixed(2)} Cr</td><td><button class="btn btn-danger" onclick="releasePlayer(${p.id})">Release</button></td></tr>`).join("")||'<tr><td colspan="5" class="empty">No retained players yet.</td></tr>';
  }catch(e){toast(e.message)}
}
async function executeRetention(){
  try{
    const player_id=$("retentionPlayer").value,team_id=$("retentionTeam").value,amount=Number($("retentionAmount").value);
    if(!player_id||!team_id||!amount)throw new Error("Select player, previous team and retention amount");
    if(!confirm("Confirm retention? Matching RTM entitlement and purse will be reduced."))return;
    await api("/api/retention",{method:"POST",body:JSON.stringify({player_id,team_id,amount})});
    toast("Player retained successfully");await refreshAll();await loadRetention();
  }catch(e){toast(e.message)}
}
async function releasePlayer(id){
  try{if(!await announceConfirm("Confirm player release?","This player will return to the auction pool. The retention amount and RTM entitlement will be refunded to the team.","✓ CONFIRM RELEASE"))return;
    await api("/api/release",{method:"POST",body:JSON.stringify({player_id:id})});
    toast("Player released to auction pool");await refreshAll();await loadRetention();await loadAuction();
  }catch(e){toast(e.message)}
}

async function loadUnsold(){try{const rows=await api("/api/players?status=UNSOLD&search="+encodeURIComponent($("unsoldSearch").value||""));$("unsoldTable").innerHTML=rows.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${p.category}</td><td>${esc(p.role)}</td><td>${esc(p.previous_team||"—")}</td><td><button class="btn btn-gold" onclick="reauction(${p.id})">Bring Back</button></td></tr>`).join("")||'<tr><td colspan="5" class="empty">No unsold players.</td></tr>'}catch(e){toast(e.message)}}
async function reauction(id){try{await api("/api/reauction",{method:"POST",body:JSON.stringify({player_id:id})});toast("Player returned to auction");await loadUnsold();await loadAuction();await loadStats()}catch(e){toast(e.message)}}
async function loadSold(){try{const rows=await api("/api/sold");$("soldTable").innerHTML=rows.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${p.category}</td><td>${esc(p.current_team||"—")}</td><td>₹${Number(p.sold_price||0).toFixed(2)} Cr</td><td><button class="btn btn-danger" onclick="bringSoldBack(${p.id},'${esc(p.name)}','${esc(p.current_team||"")}','${Number(p.sold_price||0)}')">Cancel sale / Bring back</button></td></tr>`).join("")||'<tr><td colspan="5" class="empty">No sold players.</td></tr>'}catch(e){toast(e.message)}}
async function bringSoldBack(id,name,team,amount){try{if(!await announceConfirm("Cancel this sale?",`<b>${esc(name)}</b><br>Sold to <b>${esc(team)}</b><br>Refund: <b>₹${Number(amount).toFixed(2)} Cr</b><br>Player will return to the auction pool.`,"✓ YES · CANCEL SALE"))return;await api("/api/sold/bring-back",{method:"POST",body:JSON.stringify({player_id:id})});toast("Sale cancelled. Purse refunded and player returned to auction.","success");await refreshAll();await loadSold();await loadAuction()}catch(e){toast(e.message)}}
async function fillTradeSelects(){await loadPlayers();const owned=players.filter(p=>p.current_team_id);$("tradePlayer").innerHTML=owned.map(p=>`<option value="${p.id}">${esc(p.name)} – ${esc(p.current_team||"")}</option>`).join("")||'<option value="">No owned players</option>';fillTeamSelects()}
function updateTradePreview(){
  const from=teams.find(t=>Number(t.id)===Number($("tradeFrom").value));
  const to=teams.find(t=>Number(t.id)===Number($("tradeTo").value));
  const amount=Number($("tradeAmount").value),box=$("tradePreview");
  if(!from||!to||!Number.isFinite(amount)||amount<=0){box.textContent="Select seller, buyer and a valid amount to preview both purse changes.";return;}
  if(Number(from.id)===Number(to.id)){box.textContent="Seller and buyer must be different teams.";return;}
  box.innerHTML=`<div><b>${esc(to.name)} (Buyer)</b><span>− ₹${amount.toFixed(2)} Cr</span></div><div><b>${esc(from.name)} (Seller)</b><span>+ ₹${amount.toFixed(2)} Cr</span></div>`;
}
async function executeTrade(){
  try{
    const player_id=$("tradePlayer").value,from_team_id=$("tradeFrom").value,to_team_id=$("tradeTo").value,amount=Number($("tradeAmount").value);
    if(!player_id||!from_team_id||!to_team_id||!Number.isFinite(amount)||amount<=0)throw new Error("Complete all trade fields with a valid amount");
    if(Number(from_team_id)===Number(to_team_id))throw new Error("Choose different seller and buyer teams");
    const seller=teams.find(t=>Number(t.id)===Number(from_team_id)),buyer=teams.find(t=>Number(t.id)===Number(to_team_id));
    const ok=confirm(`Confirm trade?\\n\\nBUYER: ${buyer?.name}\\nDeduct: ₹${amount.toFixed(2)} Cr\\n\\nSELLER: ${seller?.name}\\nCredit: ₹${amount.toFixed(2)} Cr\\n\\nBoth team purses will update.`);
    if(!ok)return;
    const result=await api("/api/trade",{method:"POST",body:JSON.stringify({player_id,from_team_id,to_team_id,amount})});
    toast(`Trade completed! Buyer −₹${result.buyer_purse_deducted.toFixed(2)} Cr · Seller +₹${result.seller_purse_credited.toFixed(2)} Cr`);
    await refreshAll();await fillTradeSelects();updateTradePreview();
  }catch(e){toast(e.message)}
}
async function resetAllData(){
  if(!confirm("DANGER: Permanently delete ALL teams, players, squads, bids, trades and auction history?"))return;
  const phrase=prompt('Type DELETE ALL DATA to confirm the full reset:');
  if(phrase!=="DELETE ALL DATA"){toast("Reset cancelled. No data was deleted.");return;}
  try{
    await api("/api/reset-all-data",{method:"POST",body:JSON.stringify({confirm:"DELETE ALL DATA"})});
    activePlayer=null;available=[];toast("All auction data removed. You can start fresh.");
    await refreshAll();await loadAuction();await loadHistory();await fillTradeSelects();
  }catch(e){toast(e.message)}
}
async function loadHistory(){try{const rows=await api("/api/history");$("historyTable").innerHTML=rows.map(e=>`<tr><td><span class="status">${e.event_type}</span></td><td>${esc(e.player_name||"—")}</td><td>${(()=>{const t=teams.find(x=>x.name===e.team_name);return t?`${teamLogoMarkup(t,"team-logo history-team-logo")} ${esc(e.team_name)}`:esc(e.team_name||"—")})()}</td><td>${(()=>{const t=teams.find(x=>x.name===e.seller_team_name);return t?`${teamLogoMarkup(t,"team-logo history-team-logo")} ${esc(e.seller_team_name)}`:esc(e.seller_team_name||"—")})()}</td><td>${e.amount==null?"—":"₹"+Number(e.amount).toFixed(2)+" Cr"}</td><td>${new Date(e.created_at).toLocaleString()}</td></tr>`).join("")||'<tr><td colspan="5" class="empty">No activity yet.</td></tr>'}catch(e){}}
function openTeamModal(){$("modalContent").innerHTML=`<h3>Add Franchise Team</h3><label>Team Name<input id="newTeamName" placeholder="e.g. Chennai Super Kings"></label><label>Short Name<input id="newTeamShort" placeholder="CSK"></label><label>Logo URL (optional)<input id="newTeamLogo" placeholder="https://..."></label><button class="btn btn-gold" onclick="createTeam()">Create Team · ₹90 Cr</button>`;openModal()}
async function createTeam(){try{await api("/api/teams",{method:"POST",body:JSON.stringify({name:$("newTeamName").value,short_name:$("newTeamShort").value,logo_url:$("newTeamLogo").value})});closeModal();toast("Team created with ₹90 Cr purse");await loadTeams()}catch(e){toast(e.message)}}
function openPlayerModal(){$("modalContent").innerHTML=`<h3>Add Player</h3><label>Player Name<input id="newPlayerName"></label><label>Country<input id="newPlayerCountry"></label><label>Category<select id="newPlayerCategory"><option>Indian</option><option>Overseas</option><option>Associate</option></select></label><label>Role<select id="newPlayerRole"><option>Batter</option><option>Batting All-Rounder</option><option>Bowling All-Rounder</option><option>Bowler</option><option>Wicket Keeper</option></select></label><label>Previous Price (₹ Cr)<input id="newPlayerPrice" type="number" step=".01" value="0"></label><label>Previous Team<input id="newPlayerTeam"></label><label>Base Price (₹ Cr)<input id="newPlayerBase" type="number" step=".01" value=".50"></label><button class="btn btn-gold" onclick="createPlayer()">Save Player</button>`;openModal()}
async function createPlayer(){try{await api("/api/players",{method:"POST",body:JSON.stringify({name:$("newPlayerName").value,country:$("newPlayerCountry").value,category:$("newPlayerCategory").value,role:$("newPlayerRole").value,previous_price:$("newPlayerPrice").value,previous_team:$("newPlayerTeam").value,base_price:$("newPlayerBase").value,photo_url:$("newPlayerPhoto").value})});closeModal();toast("Player added");await refreshAll()}catch(e){toast(e.message)}}
async function importExcel(){
  const fileInput=$("excelFile"),button=$("importExcelBtn"),progress=$("importProgress"),result=$("importResult");
  try{
    const file=fileInput.files[0];if(!file)throw new Error("Choose an Excel file");
    if(!/\.(xlsx|xls)$/i.test(file.name))throw new Error("Choose an .xlsx or .xls workbook");
    const mb=(file.size/1024/1024).toFixed(2);button.disabled=true;button.textContent="Uploading…";result.textContent="";
    progress.textContent=`Preparing ${file.name} (${mb} MB)…`;
    const form=new FormData();form.append("file",file);
    const data=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open("POST","/api/import");xhr.responseType="json";
      xhr.upload.addEventListener("progress",e=>{if(e.lengthComputable){const pct=Math.round(e.loaded/e.total*100);progress.textContent=pct<100?`Uploading Excel… ${pct}%`:`Upload complete (100%). Processing rows and checking duplicate names in MongoDB…`;button.textContent=pct<100?`Uploading ${pct}%`:"Processing…";}});
      xhr.addEventListener("load",()=>{const body=xhr.response||( ()=>{try{return JSON.parse(xhr.responseText)}catch{return {}}})();if(xhr.status>=200&&xhr.status<300)resolve(body);else reject(new Error(body.error||`Import failed (HTTP ${xhr.status})`));});
      xhr.addEventListener("error",()=>reject(new Error("Network error while uploading. Please retry.")));
      xhr.addEventListener("timeout",()=>reject(new Error("Upload timed out. Check your connection and try again.")));
      xhr.timeout=180000;xhr.send(form);
    });
    progress.textContent="Import saved successfully. Refreshing player and team data…";
    result.innerHTML=`<strong>Excel Import Completed Successfully</strong><br>${Number(data.imported||0)} new players added · ${Number(data.skippedExisting||0)} already in database skipped · ${Number(data.skippedDuplicateInFile||0)} duplicate names in this file skipped · ${Number(data.skippedInvalid||0)} invalid rows skipped.<br>${Number(data.teamsImported||0)} teams added · ${Number(data.teamsSkipped||0)} existing teams skipped.`;
    progress.textContent=`Completed: processed ${Number(data.totalRows||0)} player rows.`;
    await refreshAll();toast(`${Number(data.imported||0)} players added successfully`);
  }catch(e){progress.textContent=`Import not completed: ${e.message}`;toast(e.message)}
  finally{button.disabled=false;button.textContent="Import Excel";}
}
function openModal(){$("modal").classList.add("open")}function closeModal(){$("modal").classList.remove("open")}function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function refreshAll(){await Promise.all([loadTeams(),loadPlayers(),loadStats(),loadUnsold(),loadHistory()])}
refreshAll().then(()=>loadAuction());

["tradeFrom","tradeTo","tradeAmount"].forEach(id=>{const el=$(id);if(el){el.addEventListener("change",updateTradePreview);el.addEventListener("input",updateTradePreview);}});

// --- SNK Friends feature pack ---
let auctionTimerHandle=null, auctionTimerRemaining=60, auctionTimerPaused=true;
function updateBroadcast(status,name,details){
  const a=$("broadcastPlayer"),b=$("broadcastStatus"),c=$("broadcastDetails");
  if(a)a.textContent=name||"Waiting for next player";
  if(b){b.textContent=status||"AUCTION LIVE";b.className="broadcast-status "+(status==="SOLD"?"sold":status==="UNSOLD"?"unsold":"");}
  if(c)c.textContent=details||"";
  publishBroadcastState(status,name,details);
}
async function loadSquadBuilder(){
  const sel=$("squadTeamSelect"); if(!sel)return;
  sel.innerHTML='<option value="">Select team</option>'+teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join("");
  sel.onchange=async()=>{const id=sel.value,box=$("squadBuilderContent");if(!id){box.textContent="Choose a team.";return;}
    try{const [rows]=await Promise.all([api("/api/squad/"+id)]);
      const team=teams.find(t=>Number(t.id)===Number(id));
      const roleCounts={};rows.forEach(p=>roleCounts[p.role]=(roleCounts[p.role]||0)+1);
      box.innerHTML=`<div class="squad-summary"><b>${teamLogoMarkup(team,"team-logo history-team-logo")} ${esc(team.name)}</b><span>${rows.length}/20 Players</span><span>₹${Number(team.remaining_purse).toFixed(2)} Cr remaining</span><span>Indian ${team.indian_count}/9 · Overseas slots ${team.effective_overseas}/9 · Associate ${team.associate_count}</span></div><div class="role-chips">${Object.entries(roleCounts).map(([r,n])=>`<span>${esc(r)}: ${n}</span>`).join("")}</div><table><thead><tr><th>PLAYER</th><th>CATEGORY</th><th>ROLE</th><th>TYPE</th><th>PRICE (Cr)</th></tr></thead><tbody>${rows.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.category}</td><td>${esc(p.role)}</td><td>${p.acquisition_type}</td><td>${Number(p.amount).toFixed(2)}</td></tr>`).join("")}</tbody></table>`;
    }catch(e){box.textContent=e.message;}
  };
}
async function loadAnalytics(){
  const box=$("analyticsContent");if(!box)return;
  try{
    const [stats,teamRows,history]=await Promise.all([api("/api/stats"),api("/api/teams"),api("/api/history")]);
    const totalSpend=teamRows.reduce((n,t)=>n+Number(t.spent||0),0);
    const maxSale=history.filter(x=>["SOLD","RTM","RETENTION"].includes(x.event_type)).reduce((best,x)=>Math.max(best,Number(x.amount||0)),0);
    box.innerHTML=[["Players",stats.total||0],["Sold / Retained",(Number(stats.sold)||0)+(Number(stats.retained)||0)],["Available",stats.available||0],["Unsold",stats.unsold||0],["Total Team Spend",`₹${totalSpend.toFixed(2)} Cr`],["Highest Sale",`₹${maxSale.toFixed(2)} Cr`]].map(([k,v])=>`<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("");
    $("spendingLeaderboard").innerHTML=teamRows.slice().sort((a,b)=>Number(b.spent)-Number(a.spent)).map((t,i)=>`<div class="leader-row"><b>#${i+1} ${teamLogoMarkup(t,"team-logo history-team-logo")} ${esc(t.name)}</b><span>Spent ₹${Number(t.spent).toFixed(2)} Cr</span><span>Remaining ₹${Number(t.remaining_purse).toFixed(2)} Cr</span></div>`).join("");
  }catch(e){toast(e.message)}
}
function startAuctionTimer(){
  if(auctionTimerHandle)clearInterval(auctionTimerHandle);
  if(auctionTimerPaused){const d=Math.max(5,Math.min(600,Number($("timerDuration").value)||60));auctionTimerRemaining=d;}
  auctionTimerPaused=false;renderAuctionTimer();
  auctionTimerHandle=setInterval(()=>{if(auctionTimerPaused)return;auctionTimerRemaining--;renderAuctionTimer();if(auctionTimerRemaining<=0){clearInterval(auctionTimerHandle);auctionTimerHandle=null;auctionTimerPaused=true;toast("Auction timer ended!");}},1000);
}
function pauseAuctionTimer(){auctionTimerPaused=true;if(auctionTimerHandle){clearInterval(auctionTimerHandle);auctionTimerHandle=null;}renderAuctionTimer()}
function resetAuctionTimer(){pauseAuctionTimer();auctionTimerRemaining=Math.max(5,Math.min(600,Number($("timerDuration").value)||60));renderAuctionTimer()}
function renderAuctionTimer(){const e=$("auctionTimerDisplay");if(e)e.textContent=String(Math.floor(auctionTimerRemaining/60)).padStart(2,"0")+":"+String(auctionTimerRemaining%60).padStart(2,"0")}
function applyTheme(theme){
  document.body.dataset.theme=theme;
  const select=$("themeSelect");if(select&&select.value!==theme)select.value=theme;
  toast("Theme applied: "+theme);
}
function toggleBroadcast(){window.open("/broadcast.html","_blank","noopener");}
function downloadBackup(){window.location.href="/api/backup"}
function downloadExcelReport(){window.location.href="/api/reports.xlsx"}
async function restoreBackup(){
  try{
    const f=$("restoreFile").files[0];if(!f)throw new Error("Choose a backup JSON file");
    if(!confirm("Restore replaces current database records with the selected backup. Download a backup first. Continue?"))return;
    const phrase=prompt("Type RESTORE BACKUP to confirm:");
    if(phrase!=="RESTORE BACKUP")return toast("Restore cancelled.");
    const fd=new FormData();fd.append("file",f);fd.append("confirm",phrase);
    const r=await fetch("/api/restore",{method:"POST",body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||"Restore failed");
    toast("Backup restored");await refreshAll();await loadAuction();
  }catch(e){toast(e.message)}
}

let auctionPaused=false;
function toggleAuctionPause(){
  auctionPaused=!auctionPaused;
  const b=$("auctionPauseButton");if(b)b.textContent=auctionPaused?"▶ Resume Auction":"⏸ Pause Auction";
  document.querySelectorAll(".auction-actions .btn-green,.auction-actions .btn-danger,.auction-actions .btn-purple").forEach(x=>x.disabled=auctionPaused);
  toast(auctionPaused?"Auction paused":"Auction resumed");
}

function publishBroadcastState(status,player,details,teamShort="",amount=""){
  const broadcastPayload={status,player,details,teamShort,amount};
  if(typeof socket!=="undefined")socket.emit("broadcast:state",broadcastPayload);
  fetch("/api/broadcast/state",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(broadcastPayload)}).catch(()=>{});
}

// --- Phase 2: nomination, profile, lineup, team analytics and auction clock ---
async function showPlayerProfile(id){
 try{
  const d=await api("/api/player/"+id),p=d.player;
  $("modalContent").innerHTML=`<div class="profile-modal">${p.photo_url?`<img class="profile-photo" src="${esc(p.photo_url)}" alt="${esc(p.name)}">`:`<div class="profile-photo profile-placeholder">${esc(p.name.split(" ").map(x=>x[0]).slice(0,2).join(""))}</div>`}
  <div><div class="eyebrow">PLAYER DOSSIER</div><h2>${esc(p.name)}</h2><p>${esc(p.country||"Country not set")} · ${p.category} · ${esc(p.role)}</p>
  <div class="profile-facts"><span>Base price <b>₹${Number(p.base_price).toFixed(2)} Cr</b></span><span>Previous team <b>${esc(p.previous_team||"—")}</b></span><span>Previous price <b>₹${Number(p.previous_price||0).toFixed(2)} Cr</b></span><span>Status <b>${p.status}</b></span></div>
  <h4>Recent bids</h4>${d.bids.length?d.bids.map(b=>`<p>${(()=>{const bt=teams.find(t=>t.name===b.team_name);return bt?teamLogoMarkup(bt,"team-logo history-team-logo"):""})()}${esc(b.team_name)} · ₹${Number(b.amount).toFixed(2)} Cr</p>`).join(""):"<p>No bids recorded.</p>"}
  <h4>Auction history</h4>${d.events.length?d.events.map(e=>`<p>${e.event_type} · ${e.amount==null?"—":"₹"+Number(e.amount).toFixed(2)+" Cr"}</p>`).join(""):"<p>No previous activity.</p>"}</div></div>`;
  openModal();
 }catch(e){toast(e.message)}
}
async function loadNominationQueue(){
 const box=$("nominationQueue");if(!box)return;
 try{
  const rows=await api("/api/nomination-queue");
  const cat=$("nominationCategory")?.value||"",role=$("nominationRole")?.value||"";
  const filtered=rows.filter(p=>(!cat||p.category===cat)&&(!role||p.role===role));
  box.innerHTML=filtered.slice(0,100).map(p=>`<button class="nomination-row" onclick="nominatePlayer(${p.id})"><span><b>${esc(p.name)}</b><small>${p.category} · ${esc(p.role)} · ₹${Number(p.base_price).toFixed(2)} Cr</small></span><strong>NOMINATE →</strong></button>`).join("")||'<p class="empty">No players match these filters.</p>';
 }catch(e){box.textContent=e.message}
}
async function nominatePlayer(id){
 const p=available.find(x=>Number(x.id)===Number(id)) || await api("/api/player/"+id).then(d=>d.player);
 if(p.status!=="AVAILABLE")return toast("This player is no longer available");
 selectPlayer(id);page("auction");toast("Player nominated to live auction");
}
async function nominateRandomPlayer(){
 try{
  const rows=await api("/api/nomination-queue"),cat=$("nominationCategory").value,role=$("nominationRole").value;
  const pool=rows.filter(p=>(!cat||p.category===cat)&&(!role||p.role===role));
  if(!pool.length)throw new Error("No available player in this category");
  nominatePlayer(pool[Math.floor(Math.random()*pool.length)].id);
 }catch(e){toast(e.message)}
}
async function loadXIAnalyzer(){
 const sel=$("xiTeamSelect"),box=$("xiAnalyzerContent");if(!sel||!box)return;
 sel.onchange=async()=>{
  if(!sel.value){box.textContent="Select a team.";return}
  try{
   const squad=await api("/api/squad/"+sel.value);
   const selected=new Set();
   const ordered=squad.slice().sort((a,b)=>{
    const rank={ "Wicket Keeper":0,"Batter":1,"Batting All-Rounder":2,"Bowling All-Rounder":3,"Bowler":4};
    return (rank[a.role]??9)-(rank[b.role]??9);
   });
   box.innerHTML=`<p class="muted">Choose up to 11 players. Suggested balance: 1 wicketkeeper, 3–5 batters, 1–3 all-rounders, 3–5 bowlers.</p><div class="xi-list">${ordered.map(p=>`<label class="xi-player"><input type="checkbox" value="${p.id}" onchange="updateXISelection()"><span><b>${esc(p.name)}</b><small>${p.category} · ${esc(p.role)}</small></span></label>`).join("")}</div><div id="xiSummary" class="xi-summary">0 / 11 selected</div><div id="xiAdvice" class="muted">Select players to see squad balance.</div>`;
   window.currentXI=ordered;
  }catch(e){box.textContent=e.message}
 };
 if(sel.value)sel.onchange();
}
function updateXISelection(){
 const checks=[...document.querySelectorAll(".xi-player input:checked")];
 if(checks.length>11){checks[checks.length-1].checked=false;return toast("Playing XI maximum is 11")}
 const picked=checks.map(c=>window.currentXI.find(p=>Number(p.id)===Number(c.value))).filter(Boolean);
 const counts={};picked.forEach(p=>counts[p.role]=(counts[p.role]||0)+1);
 $("xiSummary").textContent=`${picked.length} / 11 selected · WK ${counts["Wicket Keeper"]||0} · Batters ${counts.Batter||0} · All-rounders ${(counts["Batting All-Rounder"]||0)+(counts["Bowling All-Rounder"]||0)} · Bowlers ${counts.Bowler||0}`;
 const advice=[];
 if(picked.length===11){
  if(!counts["Wicket Keeper"])advice.push("Add a wicketkeeper");
  if((counts.Bowler||0)+(counts["Bowling All-Rounder"]||0)<3)advice.push("Consider adding more bowling options");
  if((counts.Batter||0)+(counts["Batting All-Rounder"]||0)<4)advice.push("Consider strengthening batting");
  if(!advice.length)advice.push("Balanced XI based on the selected player roles");
 }else advice.push(`${11-picked.length} more selection(s) needed`);
 $("xiAdvice").textContent=advice.join(" · ");
}
async function loadTournamentCenter(){
 const box=$("tournamentTeams");if(!box)return;
 try{
  box.innerHTML=teams.slice().sort((a,b)=>Number(b.spent)-Number(a.spent)).map((t,i)=>`<div class="team-card"><div class="team-card-head"><div class="team-title-with-logo">${teamLogoMarkup(t)}<h4>${esc(t.name)}</h4></div><span>#${i+1}</span></div><div class="purse">₹${Number(t.remaining_purse).toFixed(2)} Cr</div><p class="muted">Remaining purse · ${t.squad_size}/20 players</p><div class="role-chips"><span>Indian ${t.indian_count}</span><span>Overseas ${t.overseas_count}</span><span>Associate ${t.associate_count}</span></div><button class="btn btn-outline" onclick="viewSquad(${t.id},'${esc(t.name)}')">View Squad</button></div>`).join("")||'<p class="empty">Add teams to begin.</p>';
 }catch(e){toast(e.message)}
}

let bidClock=30,bidClockHandle=null;
function renderBidClock(){const el=$("bidCountdown");if(el)el.textContent=String(Math.floor(bidClock/60)).padStart(2,"0")+":"+String(bidClock%60).padStart(2,"0")}
function resetBidCountdown(){bidClock=30;renderBidClock();if(bidClockHandle)clearInterval(bidClockHandle);bidClockHandle=setInterval(()=>{if(auctionPaused)return;bidClock=Math.max(0,bidClock-1);renderBidClock();if(bidClock===0){clearInterval(bidClockHandle);bidClockHandle=null;playAuctionTone("end");toast("Bid countdown ended – auctioneer can close bidding.");}},1000)}
function playAuctionTone(kind){
 try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;const ctx=new C(),osc=ctx.createOscillator(),gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);osc.type="sine";osc.frequency.value=kind==="sold"?880:kind==="unsold"?260:kind==="end"?440:660;gain.gain.setValueAtTime(.0001,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.12,ctx.currentTime+.03);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.38);osc.start();osc.stop(ctx.currentTime+.4);osc.onended=()=>ctx.close()}catch(_){}
}
