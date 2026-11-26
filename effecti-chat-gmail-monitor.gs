

const CONFIG = {
  FIREBASE_PROJECT_ID: 'propostasbrava',
  FIREBASE_API_KEY: 'COLE_SUA_FIREBASE_API_KEY_AQUI',
  FIREBASE_EMAIL: 'SEU_EMAIL_DE_LOGIN_NA_CENTRAL',
  FIREBASE_PASSWORD: 'SUA_SENHA_DE_LOGIN_NA_CENTRAL',
  GMAIL_QUERY: 'from:effecti is:unread (chat OR pregoeiro OR mensagem OR convocacao OR convocação OR monitoramento OR prazo OR recurso) -label:Effecti-Alerta-Enviado',
  PROCESSED_LABEL: 'Effecti-Alerta-Enviado',

  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: ''
};

function verificarChatsEffecti() {
  const threads = GmailApp.search(CONFIG.GMAIL_QUERY, 0, 20);
  if (!threads.length) return;

  const idToken = autenticarFirebase();
  const label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) || GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  threads.forEach(thread => {
    const messages = thread.getMessages();
    const lastMsg = messages[messages.length - 1];
    const msgId = lastMsg.getId();
    const subject = lastMsg.getSubject() || 'Alerta de Chat Effecti';
    const bodyPlain = (lastMsg.getPlainBody() || '').replace(/\s+/g, ' ').trim();
    const dateIso = lastMsg.getDate().toISOString();

    const linkMatch = bodyPlain.match(/https?:\/\/[^\s<>")]+/i);
    const link = linkMatch ? linkMatch[0] : '';
    const empresa = /next\s*esportes/i.test(subject + ' ' + bodyPlain)
      ? 'Next Esportes'
      : (/brava\s*esportes/i.test(subject + ' ' + bodyPlain) ? 'Brava Esportes' : 'Equipe / Effecti');

    const payload = {
      fields: {
        id: { stringValue: 'gmail_' + msgId },
        title: { stringValue: subject.slice(0, 180) },
        message: { stringValue: bodyPlain.slice(0, 800) },
        company: { stringValue: empresa },
        source: { stringValue: 'Gmail / Effecti Monitorar' },
        url: { stringValue: link },
        read: { booleanValue: false },
        createdAt: { stringValue: dateIso },
        createdAtMs: { integerValue: String(lastMsg.getDate().getTime()) }
      }
    };

    const docUrl = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/brava_propostas/team/effecti_chat_alerts?documentId=gmail_${msgId}`;
    const res = UrlFetchApp.fetch(docUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + idToken },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() < 300 || res.getResponseCode() === 409) {
      thread.addLabel(label);
      if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
        enviarTelegram(`🚨 *ALERTA CHAT EFFECTI (${empresa})*\n*${subject}*\n\n${bodyPlain.slice(0, 350)}${link ? '\n\n🔗 ' + link : ''}`);
      }
    }
  });
}

function autenticarFirebase() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.FIREBASE_API_KEY}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      email: CONFIG.FIREBASE_EMAIL,
      password: CONFIG.FIREBASE_PASSWORD,
      returnSecureToken: true
    })
  });
  const data = JSON.parse(res.getContentText());
  return data.idToken;
}

function enviarTelegram(texto) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: texto,
      parse_mode: 'Markdown'
    }),
    muteHttpExceptions: true
  });
}

function testarEnvioAgora() {
  verificarChatsEffecti();
  Logger.log('Verificação concluída com sucesso!');
}