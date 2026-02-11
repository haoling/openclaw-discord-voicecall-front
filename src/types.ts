// ユーザーごとの音声認識状態を管理
export interface UserTranscriptionState {
  userId: string;
  username: string;
  deepgramStream: any; // Deepgram SDKの型定義が複雑なため、anyを使用
  lastAudioTime: number;
  silenceTimer: NodeJS.Timeout | null;
  currentTranscript: string;
  isSpeaking: boolean;
  lastVerboseLog: number; // VERBOSE モード用：最後のログ出力時刻
  totalSamples: number; // VERBOSE モード用：処理したサンプル数
  activeSamples: number; // VERBOSE モード用：閾値を超えたサンプル数
  reconnectAttempts: number; // Deepgram再接続試行回数
  lastReconnectTime: number; // 最後の再接続時刻
  lastSpeechFinal: boolean | null; // Deepgramから最後に受信したspeech_finalの値
  silenceStartTime: number | null; // 無音開始時刻
  isSendingToDeepgram: boolean; // Deepgramに音声データを送信中かどうか
  audioBuffer: Buffer[]; // 発話の立ち上がり部分を捉えるためのバッファ
  lastKeepAliveTime: number; // 最後のキープアライブ送信時刻
  finalTranscriptTimer: NodeJS.Timeout | null; // speech_final後のログ送信タイマー

  // 動的VADしきい値調整
  dynamicVolumeThreshold: number; // 現在のしきい値（初期値: VOLUME_THRESHOLD）
  thresholdElevationTime: number | null; // しきい値引き上げ開始時刻

  // 発話中の音量統計
  speakingVolumeSum: number; // 発話中の音量合計
  speakingVolumeCount: number; // 発話中のサンプル数
  speakingMaxVolume: number; // 発話中の最大音量
  speakingAverageVolume: number | null; // 計算済みの平均音量（speech_final時に計算）
}
