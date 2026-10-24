"use strict";
// TEST ONLY. No bank, transfer or payout provider calls are made here.
const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");
const { evaluateWithdrawal, positiveMinor } = require("../services/autoReviewWithdrawal");
const router = express.Router();
router.use(protect);
router.use((req,res,next)=>{res.set("Cache-Control","no-store");next();});
const validId = v => /^[1-9]\d*$/.test(String(v ?? "")) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const testEnabled = () => process.env.ENABLE_SELLER_WITHDRAWALS_TEST === "true" &&
  String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_test_");
function adminOnly(req,res,next) {
  const ids=String(process.env.ADMIN_USER_ID||"").split(",").map(x=>validId(x.trim())).filter(Boolean);
  if (!ids.includes(Number(req.user?.id))) return res.status(403).json({success:false,message:"GoldMart admin required."});
  next();
}
function requireTest(req,res,next) {
  if (!testEnabled()) return res.status(403).json({success:false,message:"Test withdrawals are disabled; real payouts are not available."});
  next();
}
const detailSql = [
 "SELECT a.id AS allocation_id, a.order_id, a.payment_id, a.seller_id, a.currency,",
 "a.gross_minor::text, a.commission_minor::text, a.seller_net_minor::text,",
 "a.status AS allocation_status, o.user_id AS buyer_id, o.status AS order_status,",
 "p.status AS payment_status, u.is_banned AS seller_is_banned, dc.confirmed_at AS buyer_confirmed_at,",
 "(SELECT COUNT(*)::int FROM goldmart_refund_requests r WHERE r.order_id=a.order_id) AS refund_count",
 "FROM seller_order_allocations a JOIN orders o ON o.id=a.order_id",
 "JOIN payments p ON p.id=a.payment_id JOIN users u ON u.id=a.seller_id",
 "LEFT JOIN goldmart_delivery_confirmations dc ON dc.order_id=a.order_id",
 "WHERE a.id=$1"
].join(" ");
const review = row => evaluateWithdrawal(row && {
  ...row, refund_count: row.refund_count
});
async function detail(client,id) {
  const result=await client.query(detailSql,[id]);return result.rows[0]||null;
}
async function lockOrder(client,id) {
  const lookup=await client.query("SELECT order_id FROM seller_order_allocations WHERE id=$1",[id]);
  if (!lookup.rows.length) return false;
  await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[lookup.rows[0].order_id]);
  return true;
}
async function transaction(work) {
  const client=await pool.connect();let active=false;
  try {await client.query("BEGIN");active=true;const value=await work(client);await client.query("COMMIT");active=false;return value;}
  catch(error){if(active)await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}
const failure=(res,e)=>{console.error("Withdrawal test error:",e.message);return res.status(500).json({success:false,message:"Withdrawal review unavailable. No money was moved."});};
async function notify(client,id,title,message) {
  await client.query("INSERT INTO notifications (user_id,title,message,type,is_read) VALUES ($1,$2,$3,'seller',FALSE)",[id,title,message]);
}
async function notifyAdmin(client,message) {
  const ids=String(process.env.ADMIN_USER_ID||"").split(",").map(x=>validId(x.trim())).filter(Boolean);
  if(ids.length) await client.query(
    "INSERT INTO notifications (user_id,title,message,type,is_read) SELECT id,'Seller withdrawal review',$2,'admin',FALSE FROM users WHERE id=ANY($1::integer[])",
    [ids,message]);
}

// Seller sees their own allocations and review results. No arbitrary balance.
router.get("/seller",authorize("seller","admin"),async(req,res)=>{
  try {
    const result=await pool.query([
      "SELECT a.id AS allocation_id,a.order_id,a.seller_id,a.currency,a.gross_minor::text,a.commission_minor::text,",
      "a.seller_net_minor::text,a.status AS allocation_status,o.user_id AS buyer_id,o.status AS order_status,",
      "p.status AS payment_status,u.is_banned AS seller_is_banned,dc.confirmed_at AS buyer_confirmed_at,",
      "(SELECT COUNT(*)::int FROM goldmart_refund_requests r WHERE r.order_id=a.order_id) AS refund_count,",
      "w.id AS withdrawal_id,w.status AS withdrawal_status,w.decision_reason,w.decision_source,w.created_at AS requested_at",
      "FROM seller_order_allocations a JOIN orders o ON o.id=a.order_id JOIN payments p ON p.id=a.payment_id",
      "JOIN users u ON u.id=a.seller_id LEFT JOIN goldmart_delivery_confirmations dc ON dc.order_id=a.order_id",
      "LEFT JOIN goldmart_withdrawal_requests w ON w.allocation_id=a.id WHERE a.seller_id=$1 ORDER BY a.id DESC LIMIT 50"
    ].join(" "),[req.user.id]);
    return res.json({success:true,test_mode_enabled:testEnabled(),
      message:"Simulation only. Approved tests are not bank payouts or withdrawable balances.",
      allocations:result.rows.map(r=>({
        allocation_id:r.allocation_id,order_id:r.order_id,currency:r.currency,
        gross_minor:r.gross_minor,seller_net_minor:r.seller_net_minor,allocation_status:r.allocation_status,
        order_status:r.order_status,buyer_confirmed_at:r.buyer_confirmed_at,
        withdrawal_id:r.withdrawal_id,withdrawal_status:r.withdrawal_status,
        decision_reason:r.decision_reason,decision_source:r.decision_source,requested_at:r.requested_at,
        eligibility:review(r)
      }))});
  } catch(e){return failure(res,e);}
});

// Exactly one request per seller allocation, and amount comes only from DB.
router.post("/seller",authorize("seller","admin"),requireTest,async(req,res)=>{
  const id=validId(req.body?.allocation_id);
  if(!id)return res.status(400).json({success:false,message:"Valid allocation ID required."});
  try{
    const output=await transaction(async client=>{
      if(!(await lockOrder(client,id)))return {code:404,body:{success:false,message:"Allocation not found."}};
      const a=await detail(client,id);
      if(!a||Number(a.seller_id)!==Number(req.user.id))return {code:404,body:{success:false,message:"Allocation not found for your store."}};
      const prior=await client.query("SELECT * FROM goldmart_withdrawal_requests WHERE allocation_id=$1 FOR UPDATE",[id]);
      if(prior.rows.length)return {code:200,body:{success:true,message:"Request already recorded.",withdrawal:prior.rows[0]}};
      if(!positiveMinor(a.seller_net_minor)||!["pending_review","eligible"].includes(a.allocation_status))
        return {code:409,body:{success:false,message:"This allocation cannot be requested."}};
      const decision=review(a);
      const created=await client.query([
        "INSERT INTO goldmart_withdrawal_requests",
        "(allocation_id,order_id,payment_id,seller_id,currency,amount_minor,status,decision_reason,decision_source)",
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *"
      ].join(" "),[id,a.order_id,a.payment_id,a.seller_id,a.currency,a.seller_net_minor,
        decision.status,decision.reason,decision.decision_source]);
      const w=created.rows[0];
      await notify(client,req.user.id,"Withdrawal test review",
        "Request #"+w.id+": "+decision.status.replace(/_/g," ")+". No bank transfer was made.");
      if(decision.status==="pending_review")await notifyAdmin(client,
        "Seller #"+req.user.id+" has a pending test withdrawal for order #"+a.order_id+".");
      return {code:201,body:{success:true,message:"Test request recorded; no money sent.",withdrawal:w}};
    });
    return res.status(output.code).json(output.body);
  }catch(e){return failure(res,e);}
});

// Recheck safety after buyer confirmation and waiting period. Admin hold cannot be overridden.
router.post("/seller/:id/recheck",authorize("seller","admin"),requireTest,async(req,res)=>{
  const id=validId(req.params.id);
  if(!id)return res.status(400).json({success:false,message:"Invalid request ID."});
  try{
    const output=await transaction(async client=>{
      const found=await client.query("SELECT allocation_id FROM goldmart_withdrawal_requests WHERE id=$1 AND seller_id=$2",[id,req.user.id]);
      if(!found.rows.length)return {code:404,body:{success:false,message:"Request not found."}};
      await lockOrder(client,found.rows[0].allocation_id);
      const locked=await client.query("SELECT * FROM goldmart_withdrawal_requests WHERE id=$1 FOR UPDATE",[id]);
      const w=locked.rows[0];
      if(w.status==="rejected"||w.decision_source==="admin")
        return {code:409,body:{success:false,message:"This request needs admin review."}};
      const decision=review(await detail(client,w.allocation_id));
      const updated=await client.query([
        "UPDATE goldmart_withdrawal_requests SET status=$1,decision_reason=$2,decision_source='automatic_rules',",
        "updated_at=NOW() WHERE id=$3 RETURNING *"
      ].join(" "),[decision.status,decision.reason,id]);
      return {code:200,body:{success:true,message:"Safety rechecked. No bank transfer was made.",withdrawal:updated.rows[0]}};
    });
    return res.status(output.code).json(output.body);
  }catch(e){return failure(res,e);}
});

// Admin list and decisions. Approvals never trigger a transfer.
router.get("/admin",adminOnly,async(req,res)=>{
  try{
    const result=await pool.query([
      "SELECT w.*,u.name AS seller_name,u.email AS seller_email,o.status AS order_status",
      "FROM goldmart_withdrawal_requests w JOIN users u ON u.id=w.seller_id",
      "JOIN orders o ON o.id=w.order_id",
      "ORDER BY CASE WHEN w.status='pending_review' THEN 0 ELSE 1 END,w.created_at DESC LIMIT 100"
    ].join(" "));
    return res.json({success:true,message:"Test-only review queue. Approval never transfers money.",withdrawals:result.rows});
  }catch(e){return failure(res,e);}
});
router.post("/admin/:id/decision",adminOnly,requireTest,async(req,res)=>{
  const id=validId(req.params.id),action=String(req.body?.action||""),note=String(req.body?.note||"").trim();
  if(!id||!["approve","hold","reject"].includes(action))
    return res.status(400).json({success:false,message:"Valid request and action required."});
  if(action!=="approve"&&(note.length<8||note.length>500))
    return res.status(400).json({success:false,message:"Reason must be 8–500 characters."});
  try{
    const output=await transaction(async client=>{
      const found=await client.query("SELECT allocation_id FROM goldmart_withdrawal_requests WHERE id=$1",[id]);
      if(!found.rows.length)return {code:404,body:{success:false,message:"Request not found."}};
      await lockOrder(client,found.rows[0].allocation_id);
      const locked=await client.query("SELECT * FROM goldmart_withdrawal_requests WHERE id=$1 FOR UPDATE",[id]);
      const w=locked.rows[0];
      if(w.status==="rejected")return {code:409,body:{success:false,message:"Rejected requests cannot be reopened automatically."}};
      const safety=review(await detail(client,w.allocation_id));
      if(action==="approve"&&safety.status!=="approved_test")
        return {code:409,body:{success:false,message:"Safety checks failed: "+safety.reason}};
      const status=action==="approve"?"approved_test":action==="reject"?"rejected":"pending_review";
      const reason=action==="approve"?"Admin reviewed: "+safety.reason:note;
      const updated=await client.query([
        "UPDATE goldmart_withdrawal_requests SET status=$1,decision_reason=$2,decision_source='admin',",
        "reviewed_by=$3,updated_at=NOW() WHERE id=$4 RETURNING *"
      ].join(" "),[status,reason,req.user.id,id]);
      await notify(client,w.seller_id,"Withdrawal test review updated",
        "Request #"+id+": "+status.replace(/_/g," ")+". No bank transfer was made.");
      return {code:200,body:{success:true,message:"Test decision saved. No bank transfer was made.",withdrawal:updated.rows[0]}};
    });
    return res.status(output.code).json(output.body);
  }catch(e){return failure(res,e);}
});
module.exports=router;
