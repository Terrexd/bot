require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// const play = require('play-dl'); // Removed play-dl dependency for Spotify

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
const ytDlpWrap = new YTDlpWrap(ytDlpPath);

// Map to store the queue and player for each guild
const queues = new Map();

// Global Spotify Token
let spotifyAccessToken = null;

async function getSpotifyToken() {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        console.log('Obteniendo token de Spotify manualmente...');
        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64')
                },
                body: 'grant_type=client_credentials'
            });

            const data = await response.json();

            if (data.access_token) {
                spotifyAccessToken = data.access_token;
                console.log('✅ Token de Spotify obtenido correctamente.');
                // Refresh token before it expires (approx 1 hour)
                setTimeout(getSpotifyToken, (data.expires_in - 60) * 1000);
            } else {
                console.error('❌ Error en la respuesta de Spotify:', data);
            }
        } catch (error) {
            console.error('❌ Error al conectar con Spotify:', error);
        }
    }
}

async function getSpotifyData(url) {
    if (!spotifyAccessToken) {
        throw new Error('No hay token de Spotify disponible.');
    }

    const headers = { 'Authorization': `Bearer ${spotifyAccessToken}` };
    let type = '';
    let id = '';

    if (url.includes('/track/')) {
        type = 'track';
        id = url.split('/track/')[1].split('?')[0];
    } else if (url.includes('/playlist/')) {
        type = 'playlist';
        id = url.split('/playlist/')[1].split('?')[0];
    } else if (url.includes('/album/')) {
        type = 'album';
        id = url.split('/album/')[1].split('?')[0];
    } else {
        throw new Error('Tipo de enlace de Spotify no soportado.');
    }

    if (type === 'track') {
        const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return [{ query: `${data.artists[0].name} - ${data.name}`, type: 'track' }];
    } else if (type === 'playlist') {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`, { headers });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.items.map(item => ({
            query: `${item.track.artists[0].name} - ${item.track.name}`,
            type: 'track'
        }));
    } else if (type === 'album') {
        const res = await fetch(`https://api.spotify.com/v1/albums/${id}/tracks?limit=50`, { headers });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.items.map(item => ({
            query: `${item.artists[0].name} - ${item.name}`,
            type: 'track'
        }));
    }
}


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

    await getSpotifyToken();
});

client.on('warn', console.warn);

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function playSong(guildId, songUrl) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue) return;

    if (!songUrl) {
        serverQueue.connection.destroy();
        queues.delete(guildId);
        return;
    }

    console.log(`Reproduciendo: ${songUrl}`);

    try {
        if (serverQueue.streamProcess) {
            serverQueue.streamProcess.kill();
            serverQueue.streamProcess = null;
        }

        const ytDlpProcess = spawn(ytDlpPath, [
            '-f', 'bestaudio',
            '-o', '-',
            '--extractor-args', 'youtube:player_client=default',
            '--default-search', 'ytsearch',
            songUrl
        ]);

        serverQueue.streamProcess = ytDlpProcess;

        const resource = createAudioResource(ytDlpProcess.stdout, { inlineVolume: true });
        resource.volume.setVolume(serverQueue.volume / 100);

        serverQueue.player.play(resource);
        serverQueue.resource = resource;

        ytDlpProcess.on('close', (code) => {
            if (code !== 0 && code !== null && code !== 1) {
                console.log(`yt-dlp process finished with code ${code}`);
            }
        });

        if (serverQueue.textChannel) {
            serverQueue.textChannel.send(`🎶 Reproduciendo: ${songUrl}`);
        }

    } catch (error) {
        console.error(error);
        serverQueue.songs.shift();
        playSong(guildId, serverQueue.songs[0]);
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const guildId = message.guild.id;
    const serverQueue = queues.get(guildId);

    if (message.content === '!hola') {
        message.reply('Qué pasa bro 👋');
    }

    if (message.content === '!pause') {
        if (serverQueue && serverQueue.player) {
            serverQueue.player.pause();
            message.reply('⏸️ Música pausada.');
        } else {
            message.reply('No hay nada reproduciéndose.');
        }
        return;
    }

    if (message.content === '!play') {
        if (serverQueue && serverQueue.player) {
            serverQueue.player.unpause();
            message.reply('▶️ Música reanudada.');
        } else {
            message.reply('No hay nada en pausa para reanudar.');
        }
        return;
    }

    if (message.content === '!stop') {
        if (serverQueue) {
            serverQueue.songs = [];
            if (serverQueue.streamProcess) serverQueue.streamProcess.kill();
            serverQueue.connection.destroy();
            queues.delete(guildId);
            message.reply('🛑 Bot detenido y desconectado.');
        } else {
            message.reply('No estoy reproduciendo nada.');
        }
        return;
    }

    if (message.content === '!shutdown') {
        message.reply('👋 Apagando el bot...').then(() => {
            console.log('Apagando el bot a petición del usuario.');
            client.destroy();
            process.exit(0);
        });
        return;
    }

    if (message.content === '!next') {
        if (serverQueue) {
            message.reply('⏭️ Saltando canción...');
            serverQueue.player.stop();
        } else {
            message.reply('No hay canciones en la cola.');
        }
        return;
    }

    if (message.content.startsWith('!volume')) {
        if (!serverQueue) {
            return message.reply('No hay nada reproduciéndose.');
        }
        const args = message.content.split(' ');
        const volume = parseInt(args[1]);
        if (isNaN(volume) || volume < 0 || volume > 100) {
            return message.reply('❌ Por favor, introduce un número entre 0 y 100.');
        }
        serverQueue.volume = volume;
        if (serverQueue.resource && serverQueue.resource.volume) {
            serverQueue.resource.volume.setVolume(volume / 100);
        }
        return message.reply(`🔊 Volumen ajustado a **${volume}%**`);
    }

    if (message.content === '!list') {
        if (serverQueue && serverQueue.songs.length > 0) {
            const list = serverQueue.songs.map((song, index) => `${index + 1}. ${song}`).join('\n');
            message.reply(`📜 **Cola de reproducción:**\n${list.substring(0, 1900)}`);
        } else {
            message.reply('La cola está vacía.');
        }
        return;
    }

    const isYoutube = message.content.startsWith('https://www.youtube.com/') || message.content.startsWith('https://youtu.be/');
    const isSpotify = message.content.includes('open.spotify.com');

    if (isYoutube || isSpotify) {
        if (!message.member.voice.channel) {
            return message.reply('¡Tienes que estar en un canal de voz para que ponga música!');
        }

        const url = message.content.trim();

        if (!serverQueue) {
            const queueContruct = {
                textChannel: message.channel,
                voiceChannel: message.member.voice.channel,
                connection: null,
                player: createAudioPlayer(),
                songs: [],
                playing: true,
                volume: 100,
                resource: null,
                streamProcess: null
            };

            queues.set(guildId, queueContruct);

            try {
                const connection = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                });

                queueContruct.connection = connection;
                connection.subscribe(queueContruct.player);

                queueContruct.player.on(AudioPlayerStatus.Idle, () => {
                    console.log('Canción terminada (Idle).');
                    queueContruct.songs.shift();
                    if (queueContruct.songs.length > 0) {
                        playSong(guildId, queueContruct.songs[0]);
                    } else {
                        console.log('Cola vacía, desconectando...');
                        queueContruct.connection.destroy();
                        queues.delete(guildId);
                    }
                });

                queueContruct.player.on('error', error => {
                    console.error('Error en el reproductor:', error);
                    queueContruct.songs.shift();
                    if (queueContruct.songs.length > 0) {
                        playSong(guildId, queueContruct.songs[0]);
                    } else {
                        queueContruct.connection.destroy();
                        queues.delete(guildId);
                    }
                });

                if (isSpotify) {
                    message.reply('🟢 Procesando enlace de Spotify...');
                    try {
                        const tracks = await getSpotifyData(url);
                        tracks.forEach(t => queueContruct.songs.push(`ytsearch:${t.query}`));
                        message.channel.send(`✅ Se han añadido **${tracks.length}** canciones de Spotify a la cola.`);
                        playSong(guildId, queueContruct.songs[0]);
                    } catch (err) {
                        console.error('Error con Spotify:', err);
                        message.channel.send('Hubo un error al procesar el enlace de Spotify: ' + err.message);
                        queues.delete(guildId);
                        connection.destroy();
                    }
                } else if (isYoutube && url.includes('list=')) {
                    message.reply('📜 Procesando lista de reproducción... esto puede tardar unos segundos.');
                    const ytDlpProcess = spawn(ytDlpPath, ['--flat-playlist', '--print', 'url', url]);
                    let playlistUrls = '';
                    ytDlpProcess.stdout.on('data', (data) => { playlistUrls += data.toString(); });
                    ytDlpProcess.on('close', (code) => {
                        if (code === 0) {
                            const urls = playlistUrls.trim().split('\n').filter(u => u.length > 0);
                            urls.forEach(u => queueContruct.songs.push(u));
                            if (queueContruct.songs.length > 0) {
                                message.channel.send(`✅ Se han añadido **${urls.length}** canciones a la cola.`);
                                playSong(guildId, queueContruct.songs[0]);
                            } else {
                                message.channel.send('No se encontraron canciones válidas.');
                                queues.delete(guildId);
                                connection.destroy();
                            }
                        } else {
                            message.channel.send('Hubo un error al procesar la lista.');
                            queues.delete(guildId);
                            connection.destroy();
                        }
                    });
                } else {
                    queueContruct.songs.push(url);
                    playSong(guildId, queueContruct.songs[0]);
                }

            } catch (err) {
                console.log(err);
                queues.delete(guildId);
                return message.reply('Hubo un error al conectar al canal de voz.');
            }
        } else {
            if (isSpotify) {
                message.reply('🟢 Procesando enlace de Spotify para añadir a la cola...');
                try {
                    const tracks = await getSpotifyData(url);
                    tracks.forEach(t => serverQueue.songs.push(`ytsearch:${t.query}`));
                    message.channel.send(`✅ Se han añadido **${tracks.length}** canciones de Spotify a la cola.`);
                } catch (err) {
                    console.error('Error con Spotify:', err);
                    message.channel.send('Hubo un error al procesar el enlace de Spotify: ' + err.message);
                }
            } else if (isYoutube && url.includes('list=')) {
                message.reply('📜 Procesando lista de reproducción para añadir a la cola...');
                const ytDlpProcess = spawn(ytDlpPath, ['--flat-playlist', '--print', 'url', url]);
                let playlistUrls = '';
                ytDlpProcess.stdout.on('data', (data) => { playlistUrls += data.toString(); });
                ytDlpProcess.on('close', (code) => {
                    if (code === 0) {
                        const urls = playlistUrls.trim().split('\n').filter(u => u.length > 0);
                        urls.forEach(u => serverQueue.songs.push(u));
                        message.channel.send(`✅ Se han añadido **${urls.length}** canciones a la cola.`);
                    } else {
                        message.channel.send('Hubo un error al añadir la lista.');
                    }
                });
            } else {
                serverQueue.songs.push(url);
                return message.reply(`✅ **${url}** ha sido añadida a la cola!`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);