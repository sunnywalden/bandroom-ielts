import {advanceAudioProcessing} from "./audio-processing.js";
import {acousticTool, acousticTools, pendingAcoustics} from "./acoustic-checkpoints.js";
import qaAudio from "./qa-audio.js";
import fullInterviewAudio from "./qa-full-interview-audio.js";
import {eventName, eventDefinition, fixture, hostedBrowserReview, hostedJobPattern, hostedServiceReview, pendingReviews, pumpHostedReviews, recordingBytesTool, relay, reviewRecording, reviewStatus, reviewTool, speakingQuestion, startReview, subscribe, unsubscribe} from "./work-events.js";

const json = (body, status = 200) => Response.json(body, {status, headers: {"cache-control": "no-store"}});
const noArgs = {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false};
const attemptId = "qa-speaking-01";
const textReviewSchema = (properties) => ({...noArgs, properties, required: Object.keys(properties)});
const jobId = {type: "string"};
const hostedJobId = new RegExp(hostedJobPattern);
const toolDefinitions = [
  ...acousticTools,
  {name: "read_qa_status", description: "Read isolated QA status, pending reviews and pending acoustic checkpoints owned by the signed-in account. A scheduled run can pick up pendingAcoustics when availableAt (Unix milliseconds) is due. No learner records.", inputSchema: noArgs, annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}},
  {
    name: "recover_qa_reviews",
    description: "Recover one due isolated review owned by this account, including delivery acknowledged but feedback not saved. Safe for a cloud recovery schedule. Returns jobId null when nothing is due. No learner data.",
    inputSchema: noArgs, annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "read_qa_recording_bytes",
    description: "Read bounded original recording bytes for one isolated QA job. If native audio is omitted in cloud Work, concatenate chunks in a private file and verify SHA-256 before acoustic processing. Bytes or transcription alone do not prove pronunciation assessment. Never print the base64 to the user.",
    inputSchema: {...noArgs, properties: {jobId, offset: {type: "integer", minimum: 0}, length: {type: "integer", minimum: 1, maximum: 24576}}, required: ["jobId"]},
    outputSchema: {type: "object", properties: {jobId, sha256: {type: "string"}, mimeType: {type: "string"}, totalBytes: {type: "integer"}, offset: {type: "integer"}, length: {type: "integer"}, nextOffset: {type: ["integer", "null"]}, base64: {type: "string"}}, required: ["jobId", "sha256", "mimeType", "totalBytes", "offset", "length", "nextOffset", "base64"], additionalProperties: false},
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
  },
  {
    name: "retry_qa_work_delivery",
    description: "Retry delivery of one due synthetic QA review owned by the signed-in account to its verified ChatGPT Work listener. Does not touch learner records or contact anyone else.",
    inputSchema: textReviewSchema({jobId: {...jobId, pattern: hostedJobPattern}}),
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "read_qa_text_answer", description: "Read the private QA answer and available acoustic evidence for one Work event jobId owned by the signed-in account. No learner records.",
    inputSchema: textReviewSchema({jobId}), annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
  },
  {
    name: "write_qa_text_feedback", description: "Add feedback and an exact answer quote to one private QA attempt identified by jobId and owned by the signed-in account. Existing feedback is preserved. No learner records or external recipients.",
    inputSchema: {
      ...textReviewSchema({jobId, quote: {type: "string"}, feedback: {type: "string"}}),
      properties: {
        jobId, quote: {type: "string"}, feedback: {type: "string"},
        evidenceReceipt: {type: "string", description: "For full spontaneous speech, copy the receipt returned by read_qa_text_answer."},
        evidenceIds: {type: "array", maxItems: 6, items: {type: "string"}, description: "For full spontaneous speech, cite measured sound IDs from this job."},
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {name: "read_qa_speaking_recording", description: "Read the isolated Bandroom speaking acceptance recording as native MCP audio. No real course data.", inputSchema: noArgs, annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}},
  {
    name: "write_qa_speaking_feedback",
    description: "Replace feedback on the fixed synthetic QA speaking attempt after hearing its audio. Do not submit if audio was inaccessible.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
      properties: {attemptId: {type: "string", const: attemptId}, opening: {type: "string"}, feedback: {type: "string"}},
      required: ["attemptId", "opening", "feedback"],
    },
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
  },
];

async function prepare(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS probe (name TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
}

async function mark(env, name, value = new Date().toISOString()) {
  await prepare(env);
  await env.DB.prepare("INSERT OR REPLACE INTO probe (name, value) VALUES (?, ?)").bind(name, value).run();
}

const worker = {
  async scheduled(_event, env) {
    await mark(env, "scheduled");
    await pumpHostedReviews(env);
  },
  async fetch(request, env, ctx) {
    const {pathname} = new URL(request.url);
    if (pathname === "/mcp" && request.method === "POST") {
      const {id = null, method, params} = await request.json();
      const reply = result => json({jsonrpc: "2.0", id, result});
      const error = (code, message, data) => json({jsonrpc: "2.0", id, error: {code, message, data}});
      if (method === "server/discover") return reply({supportedVersions: ["2026-07-28"], capabilities: {tools: {}, events: {}}});
      if (method === "tools/list") {
        await mark(env, "tools/list");
        return reply({tools: toolDefinitions});
      }
      if (method === "ping") return reply({});
      if (method === "events/list") {
        await mark(env, "events/list");
        return reply({events: [eventDefinition()]});
      }
      const principal = request.headers.get("oai-authenticated-user-id");
      if (!principal) return json({jsonrpc: "2.0", id, error: {code: -32001, message: "Sign in to the QA Site"}}, 401);
      if (method === "events/subscribe" && params?.name === eventName) {
        await mark(env, "events/subscribe");
        return subscribe(env, principal, params, reply, error);
      }
      if (method === "events/unsubscribe") return unsubscribe(env, principal, params, reply);
      if (method === "tools/call" && acousticTools.some(tool => tool.name === params?.name)) {
        return acousticTool(env, principal, params.name, params.arguments, reply, error);
      }
      if (method === "tools/call" && ["read_qa_text_answer", "write_qa_text_feedback"].includes(params?.name)) {
        return reviewTool(env, principal, params.name, params.arguments, reply, error);
      }
      if (method === "tools/call" && params?.name === "read_qa_recording_bytes") {
        return recordingBytesTool(env, principal, params.arguments, reply, error);
      }
      if (method === "tools/call" && params?.name === "recover_qa_reviews") {
        const result = await pumpHostedReviews(env, null, principal);
        // Advance the transport fixture only when this QA environment has configured one.
        const fixtureJobId = env.QA_TRANSPORT_FIXTURE_JOB_ID;
        const audio = fixtureJobId
          ? await advanceAudioProcessing(env.DB, principal, fixtureJobId, env.BUCKET)
          : null;
        const summary = audio?.jobId ? {...result, audioProcessing: audio} : result;
        await mark(env, "hosted_pump", JSON.stringify({at: new Date().toISOString(), via: "cloud_recovery", ...summary}));
        return reply({content: [{type: "text", text: JSON.stringify(summary)}]});
      }
      if (method === "tools/call" && params?.name === "read_qa_status") {
        await mark(env, "tools/call");
        const [siteStatus, reviews, acousticJobs] = await Promise.all([
          status(env), pendingReviews(env, principal), pendingAcoustics(env, principal),
        ]);
        const data = {...siteStatus, ...reviews, pendingAcoustics: acousticJobs};
        return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
      }
      if (method === "tools/call" && params?.name === "retry_qa_work_delivery") {
        const target = params.arguments?.jobId;
        if (typeof target !== "string" || !hostedJobId.test(target)) return error(-32602, "A synthetic hosted jobId is required.");
        const result = await pumpHostedReviews(env, target, principal);
        if (result.jobId) await mark(env, "hosted_pump", JSON.stringify({at: new Date().toISOString(), via: "mcp", ...result}));
        return reply({content: [{type: "text", text: JSON.stringify(result)}]});
      }
      if (method === "tools/call" && params?.name === "read_qa_speaking_recording") {
        await mark(env, "audio_served");
        return reply({content: [
          {type: "text", text: JSON.stringify({attemptId, prompt: "Propose a schedule change and explain your reasoning. Use the audio to quote the opening sentence, then give one specific improvement."})},
          {type: "audio", data: qaAudio, mimeType: "audio/mpeg"},
        ]});
      }
      if (method === "tools/call" && params?.name === "write_qa_speaking_feedback") {
        const {attemptId: target, opening, feedback} = params.arguments ?? {};
        if (target !== attemptId || typeof opening !== "string" || typeof feedback !== "string" || feedback.trim().length < 15 || feedback.length > 2000) {
          return error(-32602, "The synthetic attempt and heard feedback are required.");
        }
        if (opening.toLowerCase().replace(/[^a-z ]/g, "").trim() !== "the jade lantern was on the left") {
          await mark(env, "audio_verification_failed");
          return reply({isError: true, content: [{type: "text", text: "The audio verification did not match. Do not guess."}]});
        }
        await mark(env, attemptId, JSON.stringify({feedback, verified: true, savedAt: new Date().toISOString()}));
        return reply({content: [{type: "text", text: JSON.stringify({saved: true, attemptId})}]});
      }
      return error(-32601, "Method not found");
    }
    if (pathname === "/qa/relay") return relay(request, env);
    if (pathname === "/qa/hosted-review" || (pathname === "/qa/hosted-retry" && request.method === "POST")) {
      // Sites validates and consumes service credentials at the owner-private boundary.
      if (request.headers.has("oai-authenticated-user-id") || request.headers.has("origin")) {
        return json({error: "Site service access required"}, 401);
      }
      if (pathname === "/qa/hosted-review") {
        if (!["GET", "POST"].includes(request.method)) return json({error: "Method not allowed"}, 405);
        return hostedServiceReview(env, request, ctx);
      }
      const result = await pumpHostedReviews(env);
      await mark(env, "hosted_pump", JSON.stringify({at: new Date().toISOString(), ...result}));
      return json(result);
    }
    const target = /^\/qa\/reviews\/(qa_(?:phone|hosted)_[a-f0-9-]{32,36})(\/recording)?$/.exec(pathname);
    if (target && request.method === "GET") {
      const owner = request.headers.get("oai-authenticated-user-id");
      return target[2] ? reviewRecording(request, env, owner, target[1]) : reviewStatus(env, owner, target[1]);
    }
    if (pathname === "/qa/fixtures/full-interview" && request.method === "GET") {
      if (!request.headers.get("oai-authenticated-user-id")) return json({error: "Unauthorized"}, 401);
      return new Response(Uint8Array.from(atob(fullInterviewAudio), byte => byte.charCodeAt(0)), {
        headers: {"content-type": "audio/mp4", "cache-control": "no-store"},
      });
    }
    if (pathname === "/qa/reviews") {
      const owner = request.headers.get("oai-authenticated-user-id");
      if (request.method === "POST" && new URL(request.url).searchParams.get("mode") === "d2") {
        return hostedBrowserReview(env, request, ctx, owner);
      }
      if (request.method === "POST") return startReview(request, env, owner, ctx);
      if (request.method === "GET") return reviewStatus(env, owner);
      return json({error: "Method not allowed"}, 405);
    }
    if (pathname === "/probe" && request.method === "GET") return json(await status(env));
    if (pathname === "/probe" && request.method === "POST" && request.headers.get("origin") === new URL(request.url).origin) {
      await mark(env, "http_request");
      ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 4_000)).then(() => mark(env, "after_response")));
      return json({accepted: true}, 202);
    }
    if (pathname !== "/") return json({error: "Not found"}, 404);
    return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Bandroom · Work 批改验收</title>
      <h1>Bandroom · Work 批改验收</h1><p>本站仅处理独立验收数据。</p>
      <main><h2>${fixture.question}</h2><p>${fixture.answer}</p>
      <button id="queue">提交隔离作答并排队</button>
      <button id="queueHosted">提交隔离作答并验收云端重试</button>
      <h2>${speakingQuestion}</h2><p>使用本站内置的虚构录音验收转写与批改。</p>
      <button id="queueSpeaking">提交隔离录音并排队</button>
      <h2>发音声学验收</h2><p>I need three more.</p>
      <p>两个合成测试录音只改变目标词的起始音。两次提交使用相同题目。</p>
      <button id="queuePronunciationA">提交测试录音 A</button>
      <button id="queuePronunciationB">提交测试录音 B</button>
      <p>真人发音验收使用 NASA Crew-6 公开访谈的 20 秒片段。</p>
      <button id="queueInterview">提交真人访谈录音</button>
      <h2>自由口语 · 原声批改</h2>
      <p>请选择独立测试录音，最长 3 分钟，文件不超过 12 MiB。提交成功后可以关闭页面，重新打开此题即可查看反馈。</p>
      <label for="speechRecording">独立真人录音</label>
      <input id="speechRecording" type="file" accept=".mp3,.webm,.ogg,.m4a,.mp4,.wav,audio/*">
      <button id="queueFull" disabled>提交完整自由口语录音</button>
      <label><input id="simulateReadFailure" type="checkbox">验收时模拟首次读取失败</label>
      <p>也可使用 <a href="https://www.nasa.gov/podcasts/houston-we-have-a-podcast/crew-6/">NASA Crew-6 公开访谈</a>的 106 秒真人片段。</p>
      <button id="queueFullInterview">提交 106 秒真人访谈录音</button>
      <section aria-labelledby="fullHeading" id="fullReview" hidden>
        <h3 id="fullHeading">本题原声与发音反馈</h3>
        <p id="fullStatus" role="status"></p>
        <audio id="fullAudio" controls preload="metadata"></audio>
        <pre id="fullFeedback" style="white-space:pre-wrap"></pre>
        <details id="soundDetails" hidden><summary id="soundSummary">回听可对照的音素</summary><ul id="sounds"></ul></details>
      </section>
      <p id="submitStatus" role="status"></p><pre id="results"></pre></main>
      <p><a href="/qa/reviews">查看该题批改及投递记录</a> · <a href="/probe">查看系统探测</a></p>
      <script>
        const queue = document.getElementById("queue");
        const queueSpeaking = document.getElementById("queueSpeaking");
        const queuePronunciationA = document.getElementById("queuePronunciationA");
        const queuePronunciationB = document.getElementById("queuePronunciationB");
        const queueInterview = document.getElementById("queueInterview");
        const queueFull = document.getElementById("queueFull");
        const queueFullInterview = document.getElementById("queueFullInterview");
        const speechRecording = document.getElementById("speechRecording");
        const simulateReadFailure = document.getElementById("simulateReadFailure");
        const fullReview = document.getElementById("fullReview");
        const fullStatus = document.getElementById("fullStatus");
        const fullAudio = document.getElementById("fullAudio");
        const fullFeedback = document.getElementById("fullFeedback");
        const soundDetails = document.getElementById("soundDetails");
        const soundSummary = document.getElementById("soundSummary");
        const sounds = document.getElementById("sounds");
        const submitStatus = document.getElementById("submitStatus");
        const results = document.getElementById("results");
        let target = new URL(location.href).searchParams.get("review");
        let submissionId;
        let interviewSubmissionId;
        async function refreshFull() {
          if (!target) return;
          const id = target;
          fullReview.hidden = false;
          try {
            const response = await fetch("/qa/reviews/" + encodeURIComponent(id), {cache: "no-store"});
            if (id !== target) return;
            if (!response.ok) {
              fullStatus.textContent = response.status === 401 ? "请重新登录后查看反馈。" : "暂时无法读取本题，页面会自动重试。";
              return;
            }
            const job = await response.json();
            if (id !== target) return;
            let status = "正在处理原录音。";
            if (job.feedback) status = "批改已写回本题。";
            else if (!job.subscriptionActive) status = "Work 连接已到期或已暂停，录音仍可回听。";
            else if (job.reviewState === "retry_wait") status = "本次未能读取原声，云端会自动重试。录音仍可回听。";
            else if (job.reviewState === "blocked") status = job.processingReason === "qualified_analyzer_unavailable" ?
              "原录音已校验。当前没有通过验收的发音分析器，录音仍可回听。" :
              "原录音校验或分析失败，录音仍可回听。";
            else if (job.reviewState === "needs_attention") status = "自动重试后仍未收到批改，录音已保留，需检查 Work 连接。";
            else if (job.status === "failed") status = job.error === "acoustic_analysis_unavailable" ?
              "无法分析这段原录音，录音仍可回听。" : "批改请求投递失败，录音仍可回听。";
            else if (job.status === "sent") status = Date.now() - job.finishedAt > 5 * 60_000 ?
              "暂未收到反馈，云端恢复任务将重新触发批改。录音仍可回听。" : "Work 已收到请求，等待反馈。";
            else if (job.status === "retry") status = "系统将自动重试。";
            fullStatus.textContent = status;
            if (job.recordingUrl && fullAudio.getAttribute("src") !== job.recordingUrl) {
              fullAudio.src = job.recordingUrl;
              sounds.replaceChildren();
              soundDetails.hidden = true;
            }
            fullFeedback.textContent = job.feedback ?? "";
            const transportTest = job.processingStage === "qa_transport_fixture" && Boolean(job.feedback);
            const observations = transportTest ? [{start: 12, word: "回听测试点"}] : job.acousticEvidence?.observations;
            if (!sounds.childElementCount && observations?.length) {
              soundSummary.textContent = transportTest ? "回听测试" : "回听可对照的音素";
              for (const sound of observations) {
                const item = document.createElement("li");
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = sound.start.toFixed(2) + " 秒 · " + sound.word;
                button.addEventListener("click", () => {
                  fullAudio.currentTime = sound.start;
                  fullAudio.play().catch(() => {});
                });
                item.append(button);
                sounds.append(item);
              }
              soundDetails.hidden = false;
            }
          } catch {
            if (id === target) fullStatus.textContent = "暂时无法读取本题，页面会自动重试。";
          }
        }
        async function refresh() {
          const response = await fetch("/qa/reviews", {cache: "no-store"});
          if (response.ok) results.textContent = JSON.stringify((await response.json()).jobs.filter(job => job.kind === "event"), null, 2);
        }
        async function submit(button, url) {
          button.disabled = true;
          try {
            const response = await fetch(url, {method: "POST"});
            const result = await response.json();
            submitStatus.textContent = response.ok ? "已排队 " + result.jobId : result.error;
          } catch {
            submitStatus.textContent = "提交失败";
          } finally {
            button.disabled = false;
          }
        }
        queue.addEventListener("click", () => submit(queue, "/qa/reviews"));
        const queueHosted = document.getElementById("queueHosted");
        queueHosted.addEventListener("click", () => submit(queueHosted, "/qa/reviews?mode=hosted-retry"));
        queueSpeaking.addEventListener("click", () => submit(queueSpeaking, "/qa/reviews?mode=speaking"));
        queuePronunciationA.addEventListener("click", () => submit(queuePronunciationA, "/qa/reviews?mode=pronunciation-a"));
        queuePronunciationB.addEventListener("click", () => submit(queuePronunciationB, "/qa/reviews?mode=pronunciation-b"));
        queueInterview.addEventListener("click", () => submit(queueInterview, "/qa/reviews?mode=pronunciation-interview"));
        speechRecording.addEventListener("change", () => {
          submissionId = crypto.randomUUID();
          queueFull.disabled = !speechRecording.files.length;
        });
        async function fullInterview() {
          const response = await fetch("/qa/fixtures/full-interview");
          if (!response.ok) throw new Error("Unable to load the isolated interview");
          return response.blob();
        }
        async function submitFull(readAudio, id) {
          queueFull.disabled = queueFullInterview.disabled = speechRecording.disabled = simulateReadFailure.disabled = true;
          submitStatus.textContent = "正在保存录音…";
          try {
            const path = "/qa/reviews?mode=d2" + (simulateReadFailure.checked ? "&readFailure=once" : "");
            const response = await fetch(path, {
              method: "POST", headers: {"X-Bandroom-Submission": id}, body: await readAudio(),
            });
            const result = await response.json();
            if (!response.ok) {
              submitStatus.textContent = result.error;
              return;
            }
            target = result.jobId;
            const url = new URL(location.href);
            url.searchParams.set("review", target);
            history.replaceState(null, "", url);
            submitStatus.textContent = "已排队 " + target;
            refreshFull();
          } catch {
            submitStatus.textContent = "暂时无法确认是否已保存，请保留录音后重试。";
          } finally {
            queueFull.disabled = !speechRecording.files.length;
            queueFullInterview.disabled = speechRecording.disabled = simulateReadFailure.disabled = false;
          }
        }
        queueFull.addEventListener("click", () => {
          const file = speechRecording.files[0];
          if (file) submitFull(() => file, submissionId);
        });
        queueFullInterview.addEventListener("click", () => {
          interviewSubmissionId ??= crypto.randomUUID();
          submitFull(fullInterview, interviewSubmissionId);
        });
        refresh();
        setInterval(refresh, 3000);
        refreshFull();
        setInterval(refreshFull, 3000);
      </script></html>`, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
  },
};

async function status(env) {
  await prepare(env);
  return Object.fromEntries((await env.DB.prepare("SELECT name, value FROM probe ORDER BY name").all()).results.map(({name, value}) => [name, value]));
}

export default worker;
