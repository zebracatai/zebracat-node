// The README quickstart, type-checked by `npm run typecheck` (never run in tests: it would call the API).
import { Zebracat, InsufficientFundsError } from "../src/index.js";

export async function quickstart(): Promise<string | undefined> {
  const client = new Zebracat(); // reads ZEBRACAT_API_KEY

  // 1. Plan a video. Planning is free; nothing is charged until you generate.
  const started = await client.createVideo({
    brief: "How bees make honey",
    auto_generate: false,
    options: { seconds: 30, aspect: "vertical", media_type: "ai_video" },
  });

  if (!("task_id" in started)) throw new Error("dry_run answers a quote, not a video");

  // 2. Wait for the plan, then look at the price.
  const planned = await client.waitForVideo(started.task_id); // resolves at plan_ready
  console.log(await client.quoteVideo(planned.task_id));

  // 3. Generate it (this spends credit) and wait for the file.
  try {
    await client.generateVideo(planned.task_id);
  } catch (err) {
    if (err instanceof InsufficientFundsError) console.log("Add credit:", err.topupUrl, err.requestId);
    throw err;
  }
  const done = await client.waitForVideo(planned.task_id); // resolves at completed
  return done.video_url;
}
