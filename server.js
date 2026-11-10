require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const session = require("express-session");
const multer = require("multer");
const XLSX = require("xlsx");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
io.on("connection",socket=>{
  socket.on("broadcast:state",payload=>{
    if(!payload||typeof payload!=="object")return;
    const safe={
      status:String(payload.status||"AUCTION LIVE").slice(0,24),
      player:String(payload.player||"Waiting for next player").slice(0,150),
      details:String(payload.details||"").slice(0,250),
      teamShort:String(payload.teamShort||"").slice(0,20),
      amount:String(payload.amount||"").slice(0,30),
      teamLogo:payload.teamShort==="BR"?"/assets/br-bulls-logo.png":""
    };
    socket.broadcast.emit("broadcast:state",safe);
  });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "cricket_auction",
  waitForConnections: true, connectionLimit: 10, decimalNumbers: true
});

const money = n => Number(Number(n).toFixed(2));

// Safe, repeatable migration for existing databases.
async function ensurePhotoColumn() {
  try { await pool.query("ALTER TABLE players ADD COLUMN photo_url TEXT NULL"); }
  catch (e) { if (e.code !== "ER_DUP_FIELDNAME") throw e; }
}

const effectiveOverseas = counts => counts.overseas + Math.max(0, counts.associate - 2);

async function getTeamState(conn, teamId) {
  const [[team]] = await conn.query("SELECT * FROM teams WHERE id=?", [teamId]);
  if (!team) throw new Error("Team not found");
  const [rows] = await conn.query(
    `SELECT p.category, COUNT(*) AS qty FROM team_squads s
     JOIN players p ON p.id=s.player_id WHERE s.team_id=? GROUP BY p.category`, [teamId]);
  const counts = { Indian: 0, Overseas: 0, Associate: 0 };
  rows.forEach(r => counts[r.category] = Number(r.qty));
  const total = counts.Indian + counts.Overseas + counts.Associate;
  return { team, counts, total, effOverseas: effectiveOverseas({
    indian: counts.Indian, overseas: counts.Overseas, associate: counts.Associate
  }) };
}

async function validateAddition(conn, teamId, player, amount, opts={}) {
  const s = await getTeamState(conn, teamId);
  const amt = money(amount);
  if (amt < 0) throw new Error("Invalid amount");
  if (s.team.remaining_purse + 0.0001 < amt) throw new Error("Insufficient purse");
  if (s.total >= 20) throw new Error("Maximum squad size is 20");
  const c = s.counts;
  const next = { ...c, [player.category]: c[player.category] + 1 };
  const nextEff = next.Overseas + Math.max(0, next.Associate - 2);
  if (next.Indian > 9) throw new Error("Indian maximum is 9");
  if (nextEff > 9) throw new Error("Effective Overseas maximum is 9");
  // First 2 Associate players use dedicated Associate places. Every Associate from #3
  // consumes one of the 9 Overseas places (while retaining Associate as its data category).
  if (next.Associate > 11) throw new Error("Maximum Associate player count is 11 (2 dedicated + 9 overseas slots)");
  // Ensure remaining minimum requirements can still be achieved within remaining squad slots and purse.
  const totalAfter = s.total + 1;
  const slotsAfter = 17 - totalAfter;
  const indianMissing = Math.max(0, 8 - next.Indian);
  const associateMissing = Math.max(0, 1 - next.Associate);
  const overseasMissing = Math.max(0, 8 - nextEff);
  const categoryMissing = indianMissing + associateMissing + overseasMissing;
  if (categoryMissing > slotsAfter) throw new Error("This purchase makes the minimum category requirements impossible");
  const reserveSlots = Math.max(0, slotsAfter);
  const reserve = reserveSlots * 0.50;
  if (s.team.remaining_purse - amt + 0.0001 < reserve) throw new Error(`Keep at least ₹${reserve.toFixed(2)} Cr reserved for mandatory squad slots`);
  return s;
}

async function addPlayerToTeam(conn, teamId, player, amount, type) {
  await validateAddition(conn, teamId, player, amount);
  await conn.query("UPDATE teams SET remaining_purse=remaining_purse-? WHERE id=?", [money(amount), teamId]);
  await conn.query("INSERT INTO team_squads(team_id,player_id,amount,acquisition_type) VALUES(?,?,?,?)",
    [teamId, player.id, money(amount), type]);
  await conn.query("UPDATE players SET status=?, current_team_id=?, sold_price=?, acquisition_type=? WHERE id=?",
    [type === "Retention" ? "RETAINED" : "SOLD", teamId, money(amount), type, player.id]);
}

app.get("/api/health", (_,res)=>res.json({ok:true}));
app.get("/api/teams", async (_,res)=>{
  try {
    const [teams] = await pool.query("SELECT * FROM teams ORDER BY name");
    const output=[];
    for (const t of teams) {
      const s=await getTeamState(pool,t.id);
      output.push({...t,squad_size:s.total,indian_count:s.counts.Indian,overseas_count:s.counts.Overseas,
        associate_count:s.counts.Associate,effective_overseas:s.effOverseas,
        spent:money(t.initial_purse-t.remaining_purse)});
    }
    res.json(output);
  } catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/teams", async (req,res)=>{
  try {
    const {name,short_name,logo_url}=req.body;
    if(!name) return res.status(400).json({error:"Team name required"});
    const [r]=await pool.query("INSERT INTO teams(name,short_name,logo_url) VALUES(?,?,?)",[name,short_name||"",logo_url||""]);
    res.json({id:r.insertId,name});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/players", async (req,res)=>{
  try {
    const {status,search,category,role}=req.query;
    let sql="SELECT p.*,t.name AS current_team FROM players p LEFT JOIN teams t ON t.id=p.current_team_id WHERE 1=1";
    const args=[];
    if(status){sql+=" AND p.status=?";args.push(status);}
    if(search){sql+=" AND p.name LIKE ?";args.push(`%${search}%`);}
    if(category){sql+=" AND p.category=?";args.push(category);}
    if(role){sql+=" AND p.role=?";args.push(role);}
    sql+=" ORDER BY p.name";
    const [rows]=await pool.query(sql,args);res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/players", async (req,res)=>{
  try{
    const p=req.body;
    if(!p.name || !["Indian","Overseas","Associate"].includes(p.category)) throw new Error("Player name and valid category required");
    const [r]=await pool.query(
      "INSERT INTO players(name,country,category,role,previous_price,previous_team,base_price,photo_url) VALUES(?,?,?,?,?,?,?,?)",
      [p.name,p.country||"",p.category,p.role||"Batter",p.previous_price||0,p.previous_team||"",p.base_price||0.5,p.photo_url||null]);
    res.json({id:r.insertId});
  }catch(e){res.status(400).json({error:e.message});}
});
async function importTeamCodes(wb) {
  const teamSheet = wb.Sheets["Team Code Reference"];
  if (!teamSheet) return { teamsImported: 0, teamsSkipped: 0 };
  const rows = XLSX.utils.sheet_to_json(teamSheet, { defval: "" });
  // Known SNKPL purse values supplied for this auction; other codes start at 90 Cr.
  const purses = { KCG:90, ARC:90, DCS:90, VTK:90, SS:90, FCK:90, TG:87, BBC:87,
    AKS:67, KD2:67, BR:67, CC:53, RH:47, "7SV":12 };
  let teamsImported = 0, teamsSkipped = 0;
  for (const row of rows) {
    const code = String(row["Previous Team Code"] || "").trim();
    if (!code) continue;
    const purse = Number(purses[code] ?? 90);
    const [result] = await pool.query(
      "INSERT IGNORE INTO teams(name,short_name,initial_purse,remaining_purse) VALUES(?,?,?,?)",
      [code, code, purse, purse]
    );
    if (result.affectedRows) teamsImported++; else teamsSkipped++;
  }
  return { teamsImported, teamsSkipped };
}

app.post("/api/import",upload.single("file"),async(req,res)=>{
  try{
    if(!req.file) throw new Error("Choose an Excel file");
    const wb=XLSX.read(req.file.buffer,{type:"buffer"});
    const sheet=wb.Sheets["Player Import"] || wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(sheet,{defval:""});
    const teamImport = await importTeamCodes(wb);
    let imported=0, skipped=0;
    for(const row of rows){
      const norm={}; Object.keys(row).forEach(k=>norm[k.toLowerCase().trim().replace(/[^a-z0-9]/g,"")]=row[k]);
      const name=norm.playername||norm.name||norm.player;
      if(!name){skipped++;continue;}
      let cat=String(norm.category||norm.countrycategory||norm.type||"").trim();
      if(!["Indian","Overseas","Associate"].includes(cat)){skipped++;continue;}
      const role=String(norm.role||norm.playerrole||"Batter").trim();
      const price=Number(norm.previousprice||norm.previoussoldprice||norm.soldprice||0);
      const baseRaw=norm.baseprice;
      const basePrice=baseRaw===undefined || baseRaw==="" ? 0.50 : Number(String(baseRaw).replace(/[₹,]/g,"").replace(/\s*Cr\s*/i,"").replace(/C$/i,""));
      const prevTeam=String(norm.previousteam||norm.team||"").trim();
      const country=String(norm.country||cat);
      const photoUrl=String(norm.photourl||norm.photo||norm.imageurl||"").trim();
      const [exists]=await pool.query("SELECT id FROM players WHERE LOWER(name)=LOWER(?)",[String(name)]);
      if(exists.length){skipped++;continue;}
      await pool.query("INSERT INTO players(name,country,category,role,previous_price,previous_team,base_price,photo_url) VALUES(?,?,?,?,?,?,?,?)",
        [String(name).trim(),country,cat,["Batter","Batting All-Rounder","Bowling All-Rounder","Bowler","Wicket Keeper"].includes(role)?role:"Batter",Number.isFinite(price)?price:0,prevTeam,Number.isFinite(basePrice)&&basePrice>0?basePrice:0.50,photoUrl||null]);
      imported++;
    }
    res.json({imported,skipped,...teamImport});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/retention",async(req,res)=>{
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const {player_id,team_id,amount}=req.body;
    const [[p]]=await conn.query("SELECT * FROM players WHERE id=? AND status='AVAILABLE'",[player_id]);
    if(!p) throw new Error("Player is not available for retention");
    const [[t]]=await conn.query("SELECT * FROM teams WHERE id=?",[team_id]);
    if(!t) throw new Error("Team not found");
    if(!p.previous_team || p.previous_team.trim().toLowerCase() !== t.name.trim().toLowerCase())
      throw new Error("A player can only be retained by their previous-season team");
    const col=p.category==="Indian"?"indian_rtm":"overseas_rtm";
    if(t[col]<=0) throw new Error("No matching RTM entitlement remains for this category");
    await addPlayerToTeam(conn,team_id,p,amount,"Retention");
    await conn.query(`UPDATE teams SET ${col}=${col}-1 WHERE id=?`,[team_id]);
    await conn.query("INSERT INTO auction_events(player_id,team_id,event_type,amount) VALUES(?,?,?,?)",
      [p.id,team_id,"RETENTION",money(amount)]);
    await conn.commit();io.emit("auction:update");
    res.json({ok:true});
  }catch(e){await conn.rollback();res.status(400).json({error:e.message});}
  finally{conn.release();}
});
app.post("/api/release",async(req,res)=>{
  try{
    const {player_id}=req.body;
    const [r]=await pool.query("UPDATE players SET status='AVAILABLE',current_team_id=NULL,sold_price=NULL,acquisition_type=NULL WHERE id=? AND status='RETAINED'",[player_id]);
    if(!r.affectedRows) throw new Error("Retained player not found");
    await pool.query("DELETE FROM team_squads WHERE player_id=?",[player_id]);
    await pool.query("INSERT INTO auction_events(player_id,event_type) VALUES(?,'RELEASE')",[player_id]);
    io.emit("auction:update");res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/trade",async(req,res)=>{
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const {player_id,from_team_id,to_team_id,amount}=req.body;
    if(Number(from_team_id)===Number(to_team_id)) throw new Error("Choose a different buying team");
    const [[p]]=await conn.query("SELECT * FROM players WHERE id=? AND current_team_id=?",[player_id,from_team_id]);
    if(!p) throw new Error("Player does not belong to selling team");
    const ids=[Number(from_team_id),Number(to_team_id)].sort((a,b)=>a-b);
    const [lockedTeams]=await conn.query("SELECT * FROM teams WHERE id IN (?,?) ORDER BY id FOR UPDATE",ids);
    const seller=lockedTeams.find(t=>Number(t.id)===Number(from_team_id));
    const buyer=lockedTeams.find(t=>Number(t.id)===Number(to_team_id));
    if(!seller) throw new Error("Seller team not found");
    if(!buyer) throw new Error("Buyer team not found");
    const tradeAmount=money(Number(amount));
    if(!Number.isFinite(tradeAmount)||tradeAmount<=0) throw new Error("Enter a valid trade amount greater than zero");
    if(Number(buyer.remaining_purse)<tradeAmount) throw new Error("Buyer team does not have enough purse");
    await validateAddition(conn,to_team_id,p,tradeAmount);
    await conn.query("DELETE FROM team_squads WHERE player_id=?",[player_id]);
    await conn.query("UPDATE teams SET remaining_purse=remaining_purse-? WHERE id=?",[tradeAmount,to_team_id]);
    await conn.query("UPDATE teams SET remaining_purse=remaining_purse+? WHERE id=?",[tradeAmount,from_team_id]);
    await conn.query("INSERT INTO team_squads(team_id,player_id,amount,acquisition_type) VALUES(?,?,?,'Trade')",
      [to_team_id,player_id,tradeAmount]);
    await conn.query("UPDATE players SET current_team_id=?,sold_price=?,acquisition_type='Trade' WHERE id=?",
      [to_team_id,tradeAmount,player_id]);
    await conn.query("INSERT INTO trades(player_id,from_team_id,to_team_id,amount) VALUES(?,?,?,?)",
      [player_id,from_team_id,to_team_id,tradeAmount]);
    await conn.query("INSERT INTO auction_events(player_id,team_id,event_type,amount,details) VALUES(?,?,?,?,JSON_OBJECT('from_team_id',?,'buyer_only_deduction',true))",
      [player_id,to_team_id,"TRADE",tradeAmount,from_team_id]);
    await conn.commit();io.emit("auction:update");
    const [[buyerAfter]]=await conn.query("SELECT remaining_purse FROM teams WHERE id=?",[to_team_id]);
    const [[sellerAfter]]=await conn.query("SELECT remaining_purse FROM teams WHERE id=?",[from_team_id]);
    res.json({ok:true,amount:tradeAmount,buyer_purse_deducted:tradeAmount,seller_purse_credited:tradeAmount,
      buyer_remaining_purse:Number(buyerAfter.remaining_purse),seller_remaining_purse:Number(sellerAfter.remaining_purse)});
  }catch(e){await conn.rollback();res.status(400).json({error:e.message});}
  finally{conn.release();}
});
app.post("/api/bid",async(req,res)=>{
  try{
    const {player_id,team_id,amount}=req.body;
    const [[p]]=await pool.query("SELECT * FROM players WHERE id=? AND status='AVAILABLE'",[player_id]);
    if(!p) throw new Error("Player is not available");
    await validateAddition(pool,team_id,p,amount);
    await pool.query("INSERT INTO auction_bids(player_id,team_id,amount) VALUES(?,?,?)",[player_id,team_id,money(amount)]);
    const [[team]]=await pool.query("SELECT name FROM teams WHERE id=?",[team_id]);
    io.emit("auction:bid",{player_id,team_id,team:team.name,amount:money(amount)});
    res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/sold",async(req,res)=>{
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const {player_id,team_id,amount}=req.body;
    const [[p]]=await conn.query("SELECT * FROM players WHERE id=? AND status='AVAILABLE' FOR UPDATE",[player_id]);
    if(!p) throw new Error("Player is not available");
    await addPlayerToTeam(conn,team_id,p,amount,"Auction");
    await conn.query("INSERT INTO auction_events(player_id,team_id,event_type,amount) VALUES(?,?,?,?)",
      [player_id,team_id,"SOLD",money(amount)]);
    await conn.commit();io.emit("auction:update");res.json({ok:true});
  }catch(e){await conn.rollback();res.status(400).json({error:e.message});}
  finally{conn.release();}
});
app.post("/api/unsold",async(req,res)=>{
  try{
    const {player_id}=req.body;
    const [r]=await pool.query("UPDATE players SET status='UNSOLD',current_team_id=NULL WHERE id=? AND status='AVAILABLE'",[player_id]);
    if(!r.affectedRows) throw new Error("Player is not available");
    await pool.query("INSERT INTO auction_events(player_id,event_type) VALUES(?,'UNSOLD')",[player_id]);
    io.emit("auction:update");res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/reauction",async(req,res)=>{
  try{
    const {player_id}=req.body;
    const [r]=await pool.query("UPDATE players SET status='AVAILABLE' WHERE id=? AND status='UNSOLD'",[player_id]);
    if(!r.affectedRows) throw new Error("Player is not unsold");
    io.emit("auction:update");res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/rtm",async(req,res)=>{
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const {player_id,team_id,amount}=req.body;
    const [[p]]=await conn.query("SELECT * FROM players WHERE id=? AND status='AVAILABLE'",[player_id]);
    if(!p) throw new Error("Player is not available");
    if(!p.previous_team) throw new Error("Previous team is not recorded; RTM eligibility cannot be verified");
    const [[team]]=await conn.query("SELECT * FROM teams WHERE id=? AND name=? FOR UPDATE",[team_id,p.previous_team]);
    if(!team) throw new Error("Only the player's previous team can use RTM");
    const col=p.category==="Indian"?"indian_rtm":"overseas_rtm";
    if(team[col]<=0) throw new Error("No eligible RTM card remains");
    await addPlayerToTeam(conn,team_id,p,amount,"RTM");
    await conn.query(`UPDATE teams SET ${col}=${col}-1 WHERE id=?`,[team_id]);
    await conn.query("INSERT INTO auction_events(player_id,team_id,event_type,amount) VALUES(?,?,?,?)",
      [p.id,team_id,"RTM",money(amount)]);
    await conn.commit();io.emit("auction:update");res.json({ok:true});
  }catch(e){await conn.rollback();res.status(400).json({error:e.message});}
  finally{conn.release();}
});

app.get("/api/player/:id",async(req,res)=>{
  try{
    const [[player]]=await pool.query(`SELECT p.*,t.name AS current_team,t.short_name AS current_team_short
      FROM players p LEFT JOIN teams t ON t.id=p.current_team_id WHERE p.id=?`,[req.params.id]);
    if(!player)return res.status(404).json({error:"Player not found"});
    const [bids]=await pool.query(`SELECT b.amount,b.created_at,t.name AS team_name,t.short_name
      FROM auction_bids b JOIN teams t ON t.id=b.team_id WHERE b.player_id=? ORDER BY b.amount DESC,b.id DESC LIMIT 10`,[req.params.id]);
    const [events]=await pool.query(`SELECT event_type,amount,created_at FROM auction_events WHERE player_id=? ORDER BY id DESC LIMIT 10`,[req.params.id]);
    res.json({player,bids,events});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/nomination-queue",async(_,res)=>{
  try{
    const [rows]=await pool.query("SELECT id,name,category,role,base_price,photo_url FROM players WHERE status='AVAILABLE' ORDER BY category,role,name");
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/squad/:teamId",async(req,res)=>{
  try{
    const [rows]=await pool.query(`SELECT p.*,s.amount,s.acquisition_type FROM team_squads s
      JOIN players p ON p.id=s.player_id WHERE s.team_id=? ORDER BY p.category,p.name`,[req.params.teamId]);
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/stats",async(_,res)=>{
  try{
    const [[stats]]=await pool.query(`SELECT COUNT(*) total,
      SUM(status='AVAILABLE') available,SUM(status='SOLD') sold,
      SUM(status='UNSOLD') unsold,SUM(status='RETAINED') retained FROM players`);
    const [[spend]]=await pool.query("SELECT COALESCE(SUM(amount),0) total_spend FROM team_squads");
    res.json({...stats,total_spend:spend.total_spend});
  }catch(e){res.status(500).json({error:e.message});}
});

// Download a workbook containing current squads, player pool, purse and auction activity.
app.get("/api/reports.xlsx", async (_,res)=>{
  try{
    const [teams]=await pool.query("SELECT id,name,short_name,initial_purse,remaining_purse,indian_rtm,overseas_rtm FROM teams ORDER BY name");
    const [players]=await pool.query("SELECT p.name,p.country,p.category,p.role,p.status,p.previous_team,p.base_price,p.sold_price,t.name AS current_team FROM players p LEFT JOIN teams t ON t.id=p.current_team_id ORDER BY p.name");
    const [trades]=await pool.query("SELECT p.name AS player,s.name AS seller,b.name AS buyer,tr.amount,tr.created_at FROM trades tr JOIN players p ON p.id=tr.player_id JOIN teams s ON s.id=tr.from_team_id JOIN teams b ON b.id=tr.to_team_id ORDER BY tr.id DESC");
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(teams),"Teams & Purse");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(players),"Player Register");
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(trades),"Trade History");
    const data=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
    res.setHeader("Content-Disposition",'attachment; filename="SNK_Friends_Auction_Report.xlsx"');
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(data);
  }catch(e){res.status(500).json({error:e.message});}
});

// Full logical backup; contains current rows and is read-only until a restore is explicitly requested.
app.get("/api/backup",async(_,res)=>{
  try{
    const backup={app:"SNK Friends Cricket Mega Auction",version:1,created_at:new Date().toISOString(),tables:{}};
    for(const table of ["teams","players","team_squads","auction_bids","trades","auction_events"]){
      const [rows]=await pool.query(`SELECT * FROM ${table}`);
      backup.tables[table]=rows;
    }
    res.setHeader("Content-Disposition",'attachment; filename="SNK_Friends_Auction_Backup.json"');
    res.json(backup);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/reset-all-data",async(req,res)=>{
  if(req.body?.confirm!=="DELETE ALL DATA") return res.status(400).json({error:"Reset confirmation phrase is required"});
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM auction_bids");
    await conn.query("DELETE FROM trades");
    await conn.query("DELETE FROM auction_events");
    await conn.query("DELETE FROM team_squads");
    await conn.query("DELETE FROM players");
    await conn.query("DELETE FROM teams");
    for (const table of ["auction_bids","trades","auction_events","team_squads","players","teams"])
      await conn.query(`ALTER TABLE ${table} AUTO_INCREMENT=1`);
    await conn.commit(); io.emit("auction:update");
    res.json({ok:true,message:"All auction data has been removed."});
  } catch(e) { await conn.rollback(); res.status(500).json({error:e.message}); }
  finally { conn.release(); }
});


app.post("/api/restore",upload.single("file"),async(req,res)=>{
  if(req.body?.confirm!=="RESTORE BACKUP") return res.status(400).json({error:"Type RESTORE BACKUP to confirm"});
  const conn=await pool.getConnection();
  try{
    if(!req.file) throw new Error("Choose a backup JSON file");
    const backup=JSON.parse(req.file.buffer.toString("utf8"));
    const allowed=["teams","players","team_squads","auction_bids","trades","auction_events"];
    if(!backup.tables || allowed.some(t=>!Array.isArray(backup.tables[t]))) throw new Error("Invalid backup format");
    await conn.beginTransaction();
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    for(const t of allowed) await conn.query(`DELETE FROM ${t}`);
    const columns={
      teams:["id","name","short_name","logo_url","initial_purse","remaining_purse","indian_rtm","overseas_rtm","created_at"],
      players:["id","name","country","category","role","previous_price","previous_team","base_price","status","current_team_id","sold_price","acquisition_type","created_at","photo_url"],
      team_squads:["id","team_id","player_id","amount","acquisition_type","created_at"],
      auction_bids:["id","player_id","team_id","amount","created_at"],
      trades:["id","player_id","from_team_id","to_team_id","amount","created_at"],
      auction_events:["id","player_id","team_id","event_type","amount","details","created_at"]
    };
    for(const t of allowed){
      for(const row of backup.tables[t]){
        const cols=columns[t].filter(c=>Object.prototype.hasOwnProperty.call(row,c));
        if(!cols.length) continue;
        const vals=cols.map(c=>row[c]);
        await conn.query(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`,vals);
      }
    }
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
    await conn.commit();io.emit("auction:update");res.json({ok:true,message:"Backup restored"});
  }catch(e){try{await conn.query("SET FOREIGN_KEY_CHECKS=1");await conn.rollback()}catch(_){}res.status(400).json({error:e.message});}
  finally{conn.release();}
});

app.get("/api/latest-team",async(_,res)=>{
  try {
    const [[row]] = await pool.query(`SELECT t.id,t.name FROM auction_events e
      JOIN teams t ON t.id=e.team_id
      WHERE e.event_type IN ('SOLD','RTM','RETENTION','TRADE')
      ORDER BY e.id DESC LIMIT 1`);
    res.json(row || null);
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get("/api/history",async(_,res)=>{
  try{
    const [rows]=await pool.query(`SELECT e.*,p.name player_name,t.name team_name,
      seller.name seller_team_name
      FROM auction_events e LEFT JOIN players p ON p.id=e.player_id
      LEFT JOIN teams t ON t.id=e.team_id
      LEFT JOIN teams seller ON seller.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(e.details,'$.from_team_id')) AS UNSIGNED)
      ORDER BY e.id DESC LIMIT 200`);
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const PORT=process.env.PORT||3000;
server.listen(PORT,async()=>{
  try { await ensurePhotoColumn(); console.log("Player photo column ready."); }
  catch(e) { console.error("Photo column migration failed:",e.message); }
  console.log(`Cricket Mega Auction running at http://localhost:${PORT}`);
});
