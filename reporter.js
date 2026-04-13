/**
 * reporter.js — Posts agent activity to the Mission Control server (server.js)
 * Fire-and-forget — never throws, never blocks the agent.
 */

const MC = process.env.MISSION_CONTROL_URL || "http://localhost:3001";

async function post(path, body) {
  try {
    await fetch(`${MC}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch {} // silently ignore if server is down
}

export const reporter = {
  status:   (status, task = "")    => post("/agent/status",   { status, task }),
  feed:     (message, type = "sys") => post("/agent/feed",    { message, type }),
  trade:    (trade)                 => post("/agent/trade",   trade),
  position: (pos)                  => post("/agent/position", pos),
  equity:   (value)                => post("/agent/equity",   { value }),
  holdings: (holdings)             => post("/agent/holdings", { holdings }),
  params:   (params)               => post("/agent/params",   params),
};
