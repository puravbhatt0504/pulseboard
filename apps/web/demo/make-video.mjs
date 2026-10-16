// node demo/make-video.mjs → docs/realtime-demo.mp4: Alice's and Bob's recordings side by side, setup trimmed off.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { a, b, duration } = JSON.parse(readFileSync("demo/out/cut.json", "utf8"));
const out = "../../docs/realtime-demo.mp4";
execFileSync("ffmpeg", [
  "-y",
  "-ss", a.from.toFixed(2), "-t", duration.toFixed(2), "-i", a.file,
  "-ss", b.from.toFixed(2), "-t", duration.toFixed(2), "-i", b.file,
  // 8 px divider between the two screens, then H.264 that plays everywhere (GitHub, LinkedIn, browsers).
  "-filter_complex", "[0:v]pad=iw+8:ih:0:0:color=#e4e4e7[l];[l][1:v]hstack=inputs=2,fps=30,format=yuv420p[v]",
  "-map", "[v]", "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", out,
], { stdio: "inherit" });
console.log(`wrote ${out}`);
// GIF for the README: GitHub plays it inline (a committed mp4 only opens as a download).
execFileSync("ffmpeg", [
  "-y", "-i", out,
  "-vf", "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  "../../docs/realtime-demo.gif",
], { stdio: "inherit" });
console.log("wrote ../../docs/realtime-demo.gif");
