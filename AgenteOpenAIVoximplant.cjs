const WebSocket = require('ws');
const dotenv = require('dotenv');
const axios = require('axios'); // Para llamadas HTTP al webhook de Make
dotenv.config();

// Configuración de Deepgram y OpenAI
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgramUrl = process.env.DEEPGRAM_URL;

const openAIUrl = process.env.OPENAI_URL;
const openAIAuthToken = process.env.OPENAI_AUTH_TOKEN;
const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL; // URL del webhook de Make para envío de correos

// Crear el servidor WebSocket para Vox en el puerto 3000
const wssVox = new WebSocket.Server({ port: 3000 }, () => {
    console.log('Servidor WebSocket VOX iniciado en el puerto 3000.');
});

wssVox.on('connection', (wsVox) => {
    console.log('✅ Cliente WebSocket VOX conectado.');
    // Buffer para almacenar los datos de audio recibidos desde OpenAI.
    let audioBufferVox = Buffer.alloc(0);
    let sendAudioInterval = null;
    const customChunkSize = 800;
    let usarBufferManual = true; // Cambia a false si no quieres usar el buffer manual
    let startTime;
    let secs = 0;
    let msg_id = 0;
    // Asignar un objeto de estado para cada conexión
    wsVox.state = {
        transcText: [],
        newMessage: false,
        // Para almacenar contexto de usuario si es necesario
        userEmail: null,
        userName: null
    };

    /*** Conexión a Deepgram para este cliente ***/
    wsVox.deepgramSocket = new WebSocket(deepgramUrl, {
        headers: { Authorization: `Token ${deepgramApiKey}` }
    });

    wsVox.deepgramSocket.on('open', () => {
        console.log('Conexión a Deepgram establecida para este cliente.');
    });

    wsVox.deepgramSocket.on('message', (message) => {
        const messageStr = message.toString();
        try {
            const jsonResponse = JSON.parse(messageStr);

            if (jsonResponse.type === 'Results' && jsonResponse.channel && jsonResponse.channel.alternatives) {
                const transcript = jsonResponse.channel.alternatives[0].transcript;
                if (transcript && transcript !== '') {
                    wsVox.state.transcText.push(transcript);
                    if (msg_id != 0) {
                        msg_id = 0;
                        console.log("Limpiando buffer MANUAL de audio.");
                        if (usarBufferManual) {
                            clearInterval(sendAudioInterval);
                            sendAudioInterval = null;
                            audioBufferVox = Buffer.alloc(0);
                        }
                    }
                }
                if (jsonResponse.speech_final === true && wsVox.state.transcText.join(' ').trim() !== '') {
                    // Preparar y enviar mensaje a OpenAI
                    const eventSend = {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [
                                { type: "input_text", text: wsVox.state.transcText.join(' ') }
                            ]
                        },
                    };
                    wsVox.openAISocket.send(JSON.stringify(eventSend));
                    console.log("USER: " + wsVox.state.transcText.join(' '));

                    wsVox.state.transcText = [];
                    wsVox.state.newMessage = true;
                }
            }

        } catch (error) {
            console.error('Error al parsear JSON de Deepgram:', error);
        }
    });

    wsVox.deepgramSocket.on('error', (error) => {
        console.error('Error en la conexión Deepgram para este cliente:', error.message);
    });

    wsVox.deepgramSocket.on('close', () => {
        console.log('Conexión a Deepgram cerrada para este cliente.');
    });

    /*** Conexión a OpenAI para este cliente ***/
    wsVox.openAISocket = new WebSocket(openAIUrl, {
        headers: {
            "Authorization": "Bearer " + openAIAuthToken,
            "OpenAI-Beta": "realtime=v1",
        },
    });

    wsVox.openAISocket.on("open", () => {
        console.log("Conexión a OpenAI establecida para este cliente.");
        // Incluir definiciones de funciones para uso de herramientas (function-calling)
        const sessionUpdate = {
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": prompt,
                "voice": "sage",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": "whisper-1",
                    "language": "es",
                    "prompt": "Transcribe el siguiente audio en vivo..."
                },
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500,
                    "create_response": true
                },
                "temperature": 0.6,
                "max_response_output_tokens": "inf",
                "tools": [
                    {
                        "type": "function",
                        "name": "send_email_notification",
                        "description": "Envía datos de reunión o cotización a un webhook para generar y enviar un correo electrónico.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "email": {
                                    "type": "string",
                                    "description": "Correo electrónico del usuario o destinatario"
                                },
                                "name": {
                                    "type": "string",
                                    "description": "Nombre del usuario o destinatario"
                                },
                                "type": {
                                    "type": "string",
                                    "enum": ["reunion", "cotizacion"],
                                    "description": "Tipo de notificación: 'reunion' o 'cotizacion'"
                                },
                                "fecha": {
                                    "type": "string",
                                    "description": "Fecha de la reunión en formato ISO o descripción legible"
                                },
                                "detalles": {
                                    "type": "string",
                                    "description": "Detalles adicionales para la cotización o contexto"
                                }
                            },
                            "required": ["email", "name", "type", "fecha"]
                        }
                    }
                ],
                "tool_choice": "auto"
            }
        };
        wsVox.openAISocket.send(JSON.stringify(sessionUpdate));

    });

    wsVox.openAISocket.on("message", async (message) => {
        let msg;
        try {
            msg = JSON.parse(message.toString());
        } catch (err) {
            console.error('Error parseando mensaje de OpenAI:', err);
            return;
        }

        switch (msg.type) {
            case "conversation.item.created":
                // Enviar señal de inicio de transmisión a este cliente
                startTime = Date.now();
                const startConnection = {
                    event: 'start',
                    sequenceNumber: 0,
                    start: { mediaFormat: { encoding: 'PCM16', sampleRate: 24000 } }
                };
                if (wsVox.readyState === WebSocket.OPEN) {
                    wsVox.send(JSON.stringify(startConnection));
                    console.log("INICIA TRANSMISIÓN para este cliente.");
                }
                if (wsVox.state.newMessage) {
                    const eventRespond = {
                        type: "response.create",
                        response: { modalities: ["text", "audio"] },
                    };
                    wsVox.openAISocket.send(JSON.stringify(eventRespond));
                    wsVox.state.newMessage = false;
                }
                break;
            case "response.audio_transcript.done":
                console.log("BOT: " + msg.transcript);
                break;

            case "response.audio.delta":
                msg_id = msg.item_id;
                if (msg?.delta) {
                    if (usarBufferManual) {
                        const chunkBuffer = Buffer.from(msg.delta, "base64");
                        audioBufferVox = Buffer.concat([audioBufferVox, chunkBuffer]);

                        if (!sendAudioInterval) {
                            sendAudioInterval = setInterval(() => {
                                if (audioBufferVox.length >= customChunkSize) {
                                    const chunkToSend = audioBufferVox.slice(0, customChunkSize);
                                    audioBufferVox = audioBufferVox.slice(customChunkSize);
                                    const audioData = {
                                        event: 'media',
                                        media: {
                                            chunk: Date.now(),
                                            payload: chunkToSend.toString("base64"),
                                            timestamp: Date.now()
                                        }
                                    };
                                    wsVox.send(JSON.stringify(audioData));
                                }
                                if (audioBufferVox.length === 0) {
                                    clearInterval(sendAudioInterval);
                                    sendAudioInterval = null;
                                }
                            }, 15);
                        }
                    }
                }
                break;

            // Manejo de llamada de función function-calling de OpenAI:
            case "response.function_call":
                // Ejemplo de estructura: msg.function_call.name y msg.function_call.arguments (JSON string)
                if (msg.function_call && msg.function_call.name === 'send_email_notification') {
                    try {
                        const args = JSON.parse(msg.function_call.arguments);
                        console.log('Function call para enviar email:', args);
                        // Llamar al webhook de Make
                        if (!makeWebhookUrl) {
                            console.error('MAKE_WEBHOOK_URL no está configurado');
                        } else {
                            // Construir payload:
                            const payload = {
                                email: args.email,
                                name: args.name,
                                tipo: args.type,
                                fecha: args.fecha,
                                detalles: args.detalles || ''
                            };
                            // Enviar petición POST al webhook
                            axios.post(makeWebhookUrl, payload)
                                .then(response => {
                                    console.log('Webhook Make respondido:', response.status);
                                    // Opcional: notificar al usuario en la conversación
                                    const confirmMsg = `✅ Se ha enviado ${args.type === 'reunion' ? 'la invitación de reunión' : 'la cotización'} al correo ${args.email}.`;
                                    // Enviar mensaje de texto al cliente Vox para que escuche confirmación
                                    if (wsVox.readyState === WebSocket.OPEN) {
                                        const msgTexto = JSON.stringify({ event: 'text', content: confirmMsg });
                                        wsVox.send(msgTexto);
                                    }
                                })
                                .catch(error => {
                                    console.error('Error al llamar al webhook Make:', error.message);
                                });
                        }
                    } catch (error) {
                        console.error('Error parseando argumentos de function_call:', error);
                    }
                }
                break;
            // default:
                // console.log("Evento de OpenAI no manejado: " + JSON.stringify(msg));

        }
    });

    wsVox.openAISocket.on("error", (err) => {
        console.error("Error en OpenAI para este cliente:", err.message);
    });

    wsVox.openAISocket.on("close", () => {
        console.log("Conexión a OpenAI cerrada para este cliente.");
    });

    /*** Manejo de mensajes desde Vox (audio u otros eventos) ***/
    wsVox.on('message', (dataVox) => {
        try {
            const data = JSON.parse(dataVox);
            switch (data.event) {
                case "start":
                    console.log("llamada iniciada");
                    break;
                case "media":
                    enviarAudio(data, wsVox);
                    break;
                case "stop":
                    console.log("Llamada finalizada");
                    if (usarBufferManual) {
                        if (sendAudioInterval) {
                            clearInterval(sendAudioInterval);
                            sendAudioInterval = null;
                        }
                        audioBufferVox = Buffer.alloc(0);
                    }
                    break;
                default:
                    console.log(`Evento no manejado: ${data.event}`);
            }
        } catch (error) {
            console.error("Error procesando el mensaje de Voximplant:", error);
        }
    });

    wsVox.on('close', () => {
        console.log('❌ Conexión WebSocket VOX cerrada para este cliente.');
        if (wsVox.deepgramSocket && wsVox.deepgramSocket.readyState === WebSocket.OPEN) {
            wsVox.deepgramSocket.close();
        }
        if (wsVox.openAISocket && wsVox.openAISocket.readyState === WebSocket.OPEN) {
            wsVox.openAISocket.close();
        }
    });

    wsVox.on('error', (err) => {
        console.error(`⚠️ Error en WebSocket VOX para este cliente: ${err.message}`);
    });

    // Enviar mensaje inicial al cliente Vox
    wsVox.send(JSON.stringify({ message: '🔗 Conexión establecida con el servidor WebSocket VOX.' }));
    setInterval(() => { wsVox.deepgramSocket.send(JSON.stringify({ "type": "KeepAlive" })) }, 6000);
});

/*** Función para enviar audio a Deepgram para una conexión específica ***/
function enviarAudio(voximplantData, wsVox) {
    try {
        const audioBufferDeep = Buffer.from(voximplantData.media.payload, 'base64');
        if (wsVox.deepgramSocket && wsVox.deepgramSocket.readyState === WebSocket.OPEN) {
            wsVox.deepgramSocket.send(audioBufferDeep);
        } else {
            console.warn('La conexión a Deepgram no está abierta para este cliente.');
        }
    } catch (error) {
        console.error("Error al procesar el audio de Voximplant:", error);
    }
}

// Define el prompt (puedes mantener el contenido completo que necesites)
const prompt = "eres un agente de ventas que agenda reuniones en caso de no concretar la venta o  envia cotizaciones en caso de concretar la venta. Si detectas que el usuario provee email o nombre, almacénalos en contexto. Cuando corresponda, llama a la función send_email_notification con los parámetros adecuados.";
