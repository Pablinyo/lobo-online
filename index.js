const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configuración de CORS para permitir conexiones desde cualquier sitio (móviles, web)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- BASE DE DATOS EN MEMORIA ---
const rooms = {}; 

/* Estructura de una sala en 'rooms':
"ABCD": {
    hostId: "socket_id_narrador",
    players: [
        { name: "Juan", id: 123456, assignedSocketId: null }, // Null significa que nadie lo ha reclamado
        { name: "Ana", id: 789012, assignedSocketId: "socket_id_jugador" }
    ],
    status: "lobby"
}
*/

io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // 1. CREAR SALA (El Narrador inicia)
    socket.on('create_room', ({ hostName }, callback) => {
        // Generamos código de 4 letras
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        rooms[roomCode] = {
            hostId: socket.id,
            hostName: hostName,
            players: [], // Aquí guardaremos los nombres que meta el narrador
            status: 'lobby'
        };

        socket.join(roomCode);
        console.log(`Sala creada: ${roomCode} por ${hostName}`);
        
        // Devolvemos el código al Narrador
        callback({ roomCode });
    });

    // 2. REGISTRAR JUGADORES (El Narrador añade la lista de nombres)
    socket.on('update_player_list', ({ roomCode, players }) => {
        if (rooms[roomCode]) {
            // Guardamos la lista oficial de jugadores (nombres e IDs generados por el narrador)
            // Mantenemos el assignedSocketId si ya existía (por si alguien ya se había conectado)
            const oldPlayers = rooms[roomCode].players;
            
            // Mapeamos los nuevos, preservando conexiones si los IDs coinciden
            rooms[roomCode].players = players.map(newP => {
                const existing = oldPlayers.find(old => old.id === newP.id);
                return {
                    ...newP,
                    assignedSocketId: existing ? existing.assignedSocketId : null
                };
            });
            
            // Avisamos a todos en la sala (útil para refrescar pantallas)
            io.to(roomCode).emit('player_list_updated', rooms[roomCode].players);
        }
    });

    // 3. BUSCAR SALA (El Jugador introduce el código)
    socket.on('check_room', ({ roomCode }, callback) => {
        const room = rooms[roomCode];
        if (room) {
            callback({ valid: true });
        } else {
            callback({ valid: false, error: "Sala no encontrada" });
        }
    });

    // 4. OBTENER IDENTIDADES DISPONIBLES (El Jugador ve la lista)
    socket.on('get_available_identities', ({ roomCode }, callback) => {
        const room = rooms[roomCode];
        if (room) {
            // Solo devolvemos los jugadores que NO tienen dueño (assignedSocketId == null)
            const available = room.players.filter(p => !p.assignedSocketId);
            callback({ identities: available });
        }
    });

    // 5. RECLAMAR IDENTIDAD (El Jugador dice "Yo soy Juan")
    socket.on('claim_identity', ({ roomCode, playerId }, callback) => {
        const room = rooms[roomCode];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            if (room.players[playerIndex].assignedSocketId) {
                callback({ success: false, error: "Este jugador ya ha sido elegido por otro móvil." });
            } else {
                // Asignamos este socket al jugador
                room.players[playerIndex].assignedSocketId = socket.id;
                socket.join(roomCode);
                
                callback({ success: true });
                
                // Avisamos al Narrador de que alguien se ha conectado
                io.to(room.hostId).emit('player_connected', { 
                    playerId: playerId,
                    socketId: socket.id
                });
            }
        }
    });

    // Desconexión
    socket.on('disconnect', () => {
        // Aquí podríamos limpiar asignaciones si quisiéramos
        console.log('Usuario desconectado:', socket.id);
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`SERVIDOR LOBO CORRIENDO EN PUERTO ${PORT}`);
});