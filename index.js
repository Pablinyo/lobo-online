const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- ALMACÉN DE SALAS ---
const rooms = {}; 

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // 1. CREAR SALA (Narrador)
    // El frontend envía un objeto: { hostName, narratorName, system }
    socket.on('create_room', (data, callback) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        // Manejamos si data es un objeto (versión nueva) o string (versión vieja)
        const hostName = typeof data === 'object' ? data.hostName : data;

        rooms[roomCode] = {
            hostId: socket.id,
            hostName: hostName,
            players: [], // Aquí guardaremos { name, socketId }
            status: 'lobby',
            gameStarted: false
        };

        socket.join(roomCode);
        console.log(`Sala creada: ${roomCode} por ${hostName}`);
        
        if (callback) callback({ roomCode: roomCode });
    });

    // 2. ACTUALIZAR LISTA DE JUGADORES (Narrador define quién juega)
    socket.on('update_player_list', ({ roomId, players }) => {
        // roomId puede venir como roomId o roomCode, aseguramos compatibilidad
        const code = roomId; 
        
        if (rooms[code]) {
            // Guardamos la lista, manteniendo las conexiones (socketId) si ya existían
            const oldPlayers = rooms[code].players;
            
            rooms[code].players = players.map(newP => {
                const existing = oldPlayers.find(old => old.name === newP.name);
                return {
                    id: newP.id,
                    name: newP.name,
                    // Si ya tenía socket, lo mantenemos. Si no, null.
                    socketId: existing ? existing.socketId : null 
                };
            });
            
            // Avisamos a todos en la sala de la nueva lista
            io.to(code).emit('player_list_updated', rooms[code].players);
        }
    });

    // 3. BUSCAR SALA (Jugador intenta unirse)
    // ESTE ES EL EVENTO QUE TE FALTABA
    socket.on('check_room', (roomCode, callback) => {
        const room = rooms[roomCode];
        if (room) {
            callback({ exists: true });
        } else {
            callback({ exists: false });
        }
    });

    // 4. OBTENER IDENTIDADES DISPONIBLES (Jugador carga la lista)
    socket.on('get_available_identities', (roomCode, callback) => {
        const room = rooms[roomCode];
        if (room) {
            callback(room.players);
        } else {
            callback([]);
        }
    });

    // 5. RECLAMAR IDENTIDAD (Jugador dice "Yo soy Juan")
    socket.on('claim_identity', ({ roomId, name }, callback) => {
        const room = rooms[roomId];
        if (!room) {
            if (callback) callback(false);
            return;
        }

        const player = room.players.find(p => p.name === name);
        
        if (player) {
            if (player.socketId) {
                // Ya está cogido
                if (callback) callback(false);
            } else {
                // Está libre, se lo asignamos
                player.socketId = socket.id;
                socket.join(roomId);
                
                // Avisamos a todos para que se actualice el círculo (verde)
                io.to(roomId).emit('player_list_updated', room.players);
                
                if (callback) callback(true);
            }
        } else {
            if (callback) callback(false);
        }
    });

    // 6. EMPEZAR PARTIDA
    socket.on('start_game', (roomCode) => {
        io.to(roomCode).emit('game_start');
    });

    // Desconexión
    socket.on('disconnect', () => {
        // Opcional: Podríamos liberar el personaje si se desconecta
        console.log('Usuario desconectado:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVIDOR LOBO ACTIVO EN PUERTO ${PORT}`);
});
