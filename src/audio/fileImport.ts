import { SAMPLE_RATE } from '../config';
import { Resampler } from './resample';

/**
 * 音声ファイル（m4a/mp3/wav など、ブラウザが再生できる形式）を 16kHz・モノラルに変換する。
 * iPhoneの「ボイスメモ」等で録った音声を後から議事録にする用途を想定。
 */
export async function decodeAudioFile(file: File): Promise<Float32Array> {
  const data = await file.arrayBuffer();
  let audio: AudioBuffer;
  try {
    // 読み込みと同時に 16kHz へ変換させる（メモリ節約）
    audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data);
  } catch {
    // 16kHz の OfflineAudioContext を作れない古いブラウザ向け
    audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(data);
  }

  const mono = new Float32Array(audio.length);
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const channel = audio.getChannelData(ch);
    for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / audio.numberOfChannels;
  }
  return audio.sampleRate === SAMPLE_RATE ? mono : new Resampler(audio.sampleRate).process(mono);
}
