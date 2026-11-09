// 可插拔的伺服器端語音轉文字介面。
// 本原型預設不在伺服器做 STT：不收集、不暫存 PCM，也不呼叫任何付費或需要 API 金鑰的雲端服務。
// 即時字幕由客戶端瀏覽器的 Web Speech API（zh-TW）產生後，只把「文字」經 WebSocket 廣播。
// 若日後要接自架 Whisper 等免費／自備模型，請實作 transcribePcm，且仍不得把音訊寫入資料庫或磁碟。
'use strict';

function transcribePcm(/* pcmBuffer, opts */) {
  return Promise.resolve({
    ok: false,
    error: 'not_implemented',
    provider: null,
    text: null,
    message: '伺服器端 STT 未接上。請使用瀏覽器 Web Speech API，或自行實作此函式（不要接需付費金鑰的雲端 API，也不要保存音訊）。'
  });
}

module.exports = { transcribePcm };
