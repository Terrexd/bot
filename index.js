require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
// Mantenemos el wrapper solo para la descarga inicial si hace falta
const ytDlpWrap = new YTDlpWrap(ytDlpPath);

client.once(Events.ClientReady, async () => {
    console.log(`Bot listo como ${client.user.tag}`);

    if (!fs.existsSync(ytDlpPath)) {
        console.log('Descargando binario de yt-dlp... esto puede tardar un poco.');
        try {
            await YTDlpWrap.downloadFromGithub(ytDlpPath);
            console.log('¡yt-dlp descargado correctamente!');
        } catch (error) {
            console.error('Error descargando yt-dlp:', error);
        }
    } else {
        console.log('Binario yt-dlp encontrado.');
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!hola') {
        message.reply('Qué pasa bro 👋');
    }

    if (message.content.startsWith('https://www.youtube.com/') || message.content.startsWith('https://youtu.be/')) {
        if (!message.member.voice.channel) {
            return message.reply('¡Tienes que estar en un canal de voz para que ponga música!');
        }

        const channel = message.member.voice.channel;
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        const player = createAudioPlayer();

        try {
            let url = message.content.trim();
            console.log('URL recibida:', url);

            // Limpieza básica de URL para quitar playlist si es necesario
            if (url.includes('list=') && url.includes('v=')) {
                try {
                    const urlObj = new URL(url);
                    const videoId = urlObj.searchParams.get('v');
                    if (videoId) {
                        url = `https://www.youtube.com/watch?v=${videoId}`;
                        console.log('URL limpiada:', url);
                    }
                } catch (e) {
                    console.log('Error al limpiar URL:', e);
                }
            }

            console.log('Obteniendo URL directa con yt-dlp...');

            const ytDlpProcess = spawn(ytDlpPath, [
                '-g', // Get URL only
                '-f', 'bestaudio',
                url
            ]);

            let audioUrl = '';
            let errorOutput = '';

            ytDlpProcess.stdout.on('data', (data) => {
                audioUrl += data.toString();
            });

            ytDlpProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
                console.error(`yt-dlp stderr: ${data}`);
            });

            ytDlpProcess.on('close', (code) => {
                if (code !== 0) {
                    console.error(`yt-dlp exited with code ${code}. Error: ${errorOutput}`);
                    message.reply('Hubo un error al obtener el video.');
                    connection.destroy();
                    return;
                }

                if (!audioUrl) {
                    console.error('No se obtuvo ninguna URL de audio.');
                    message.reply('No pude encontrar el audio de ese video.');
                    connection.destroy();
                    return;
                }

                const finalUrl = audioUrl.trim().split('\n')[0]; // Por si acaso devuelve varias líneas
                console.log('URL directa obtenida, reproduciendo...');

                // Discord.js manejará el streaming desde la URL usando ffmpeg (que debe estar instalado o en node_modules)
                const resource = createAudioResource(finalUrl);
                console.log('Recurso de audio creado');

                player.play(resource);
                console.log('Reproduciendo recurso');

                connection.subscribe(player);
                console.log('Conexión suscrita al reproductor');

                message.reply(`🎶 Reproduciendo: ${url}`);
            });

            player.on('stateChange', (oldState, newState) => {
                console.log(`Audio player transition from ${oldState.status} to ${newState.status}`);
            });

            player.on('error', error => {
                console.error('Error en el reproductor de audio:', error);
            });

            player.on(AudioPlayerStatus.Idle, () => {
                console.log('Reproducción terminada, desconectando...');
                connection.destroy();
            });
        } catch (error) {
            console.error('Error detallado:', error);
            message.reply('Hubo un error al intentar reproducir el video.');
            connection.destroy();
        }
    }
});

client.login(process.env.DISCORD_TOKEN);