// Ring layout: int32 read/write/underruns/overruns, then interleaved float32 stereo.
// Indices count frames modulo capacity; one empty frame distinguishes full/empty.
class FiveAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { ring, capacity, times } = options.processorOptions;
    this.control = new Int32Array(ring, 0, 4);
    this.samples = new Float32Array(ring, 16);
    this.capacity = capacity;
    this.readControl = new Int32Array(ring, 0, 1);
    this.writeControl = new Int32Array(ring, 4, 1);
    this.monotonic = false;
    this.times = times ? new Float64Array(times) : null;
    this.probe = false;
    this.captureQueue = [];
    this.outputFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'probe') this.probe = true;
      if (data.type === 'mixer') {
        this.capacity = data.capacity;
        this.samples = new Float32Array(data.buffer, data.samples, data.capacity * 2);
        this.times = new Float64Array(data.buffer, data.times, data.capacity);
        this.mixTimes = data.mixTimes ? new Float64Array(data.buffer, data.mixTimes, data.capacity) : null;
        this.readControl = new Int32Array(data.buffer, data.read, 1);
        this.writeControl = new Int32Array(data.buffer, data.write, 1);
        this.monotonic = true;
        this.demand = data.demand ? new Int32Array(data.buffer, data.demand, 1) : null;
      }
      if (data.type === 'resume') this.discardBefore = data.since;
      if (data.type === 'capture') {
        const frames = Math.round(Math.max(.1, Math.min(30, data.seconds)) * sampleRate);
        this.captureQueue.push({id:data.id, samples:new Float32Array(frames * 2)});
      }
    };
  }
  process(inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.capture && this.captureQueue.length) {
      this.capture = { ...this.captureQueue.shift(), frames:0, started:Date.now(), startOutputFrame:this.outputFrames,
        underruns:Atomics.load(this.control,2), overruns:Atomics.load(this.control,3),
        fillMin:this.capacity, fillMax:0, fillSum:0, blocks:0, latencies:[], starvations:[], notifications:0 };
    }
    let read = Atomics.load(this.readControl, 0) >>> 0;
    const write = Atomics.load(this.writeControl, 0) >>> 0;
    let discarded = 0;
    while (this.discardBefore && this.mixTimes && read !== write) {
      if (this.mixTimes[read % this.capacity] >= this.discardBefore) { this.discardBefore = 0; break; }
      read = (read + 1) >>> 0; discarded++;
    }
    if (discarded) this.port.postMessage({ type: 'discarded', frames: discarded });
    const fill = this.monotonic ? (write - read) >>> 0 : (write - read + this.capacity) % this.capacity;
    const capture = this.capture;
    if (capture) {
      capture.fillMin = Math.min(capture.fillMin, fill); capture.fillMax = Math.max(capture.fillMax, fill);
      capture.fillSum += fill; capture.blocks++;
      // Time to the read callback; context/device latency is reported separately.
      if (fill && this.times?.[read % this.capacity]) capture.latencies.push(Date.now() - this.times[read % this.capacity]);
    }
    let count = 0;
    for (let i = 0; i < left.length; i++) {
      if (read === write) { left[i] = 0; right[i] = 0; }
      else {
        const index = (read % this.capacity) * 2;
        left[i] = this.samples[index]; right[i] = this.samples[index + 1];
        read = this.monotonic ? (read + 1) >>> 0 : (read + 1) % this.capacity; count++;
      }
    }
    Atomics.store(this.readControl, 0, read);
    if (this.demand && fill - count < 2048) {
      Atomics.add(this.demand, 0, 1); Atomics.notify(this.demand, 0, 1);
      if (capture) capture.notifications++;
    }
    if (this.monotonic) {
      Atomics.add(this.control, 0, count);
      Atomics.store(this.control, 1, fill - count);
    }
    if (count !== left.length) {
      Atomics.add(this.control, 2, 1);
      if (capture && capture.starvations.length < 100) capture.starvations.push({ frame: capture.frames, fill });
    }
    if (capture) {
      for (let i = 0; i < left.length && capture.frames * 2 < capture.samples.length; ++i) {
        capture.samples[capture.frames * 2] = left[i]; capture.samples[capture.frames * 2 + 1] = right[i];
        capture.frames++;
      }
      if (capture.frames * 2 === capture.samples.length) {
        this.capture = null;
        const { samples, latencies, ...stats } = capture;
        latencies.sort((a, b) => a - b);
        this.port.postMessage({ type: 'capture', id: capture.id, samples, stats: { ...stats,
          ended: Date.now(), endOutputFrame:this.outputFrames + left.length, sampleRate, fillMean: capture.fillSum / capture.blocks,
          underruns: Atomics.load(this.control, 2) - capture.underruns,
          overruns: Atomics.load(this.control, 3) - capture.overruns,
          latencyCount: latencies.length, latencyMin: latencies[0], latencyMax: latencies.at(-1),
          latencyMedian: latencies[Math.floor(latencies.length / 2)],
          latencyP95: latencies[Math.floor(latencies.length * .95)] } }, [samples.buffer]);
      }
    }
    this.outputFrames += left.length;
    if (this.probe && count) {
      this.probe = false;
      this.port.postMessage({ type: 'samples', count, left: Array.from(left), right: Array.from(right) });
    }
    return true;
  }
}
registerProcessor('five-audio', FiveAudio);
