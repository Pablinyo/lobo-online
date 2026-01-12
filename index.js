const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // En producción, se recomienda restringir esto a tu dominio
    methods: ["GET", "POST"]
  }
});

// --- BASE DE DATOS EN MEMORIA ---
const rooms = new Map();

// --- ORDEN MAESTRO DE LA NOCHE ---
const NIGHT_QUEUE_ORDER = [
  'ladron',        // SOLO Noche 0
  'cupido',        // SOLO Noche 0
  'nino_salvaje',  // SOLO Noche 0
  'vidente',       
  'protector',     
  'puta',          
  'lobos',         
  'lobo_albino',   
  'padre_lobo',    
  'zorro',         
  'sectario',      
  'flautista',     
  'bruja',         
  'cuervo',        
  'juez'           
];

// --- UTILIDADES ---
const generateRoomCode = () => Math.random().toString(36).substring(2, 6).toUpperCase();

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// --- SOCKET.IO LÓGICA ---
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // 1. CREACIÓN DE SALA
  socket.on('create_room', ({ hostName, system }, callback) => {
    const roomId = generateRoomCode();
    
    rooms.set(roomId, {
      id: roomId,
      hostId: socket.id,
      gameMode: system,
      players: [],
      phase: 'lobby',        
      dayCount: 0,
      rolesConfig: {},
      nightQueue: [],
      queueIndex: 0,
      currentTurnRole: null,
      wolfSpokesperson: null,
      actions: {},
      votes: {},
      globalFlags: {
          ancientPowerLoss: false,
          hunterSource: null
      }
    });

    socket.join(roomId);
    callback({ code: roomId });
    console.log(`Sala ${roomId} creada por ${hostName}`);
  });

  // 2. VALIDACIÓN DE SALA
  socket.on('check_room', (roomId, callback) => {
    callback({ exists: rooms.has(roomId) });
  });

  // 3. OBTENER IDENTIDADES DISPONIBLES
  socket.on('get_available_identities', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback([]);
    callback(room.players.map(p => ({ 
        name: p.name, 
        socketId: p.socketId 
    })));
  });

  // 4. ACTUALIZAR LISTA DE JUGADORES
  socket.on('update_player_list', ({ roomId, players }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const mergedPlayers = players.map(newP => {
        const existing = room.players.find(p => p.id === newP.id);
        return {
            id: newP.id,
            name: newP.name,
            socketId: existing ? existing.socketId : null,
            role: existing ? existing.role : 'aldeano',
            alive: existing ? existing.alive : true,
            status: existing ? existing.status : createDefaultStatus()
        };
    });

    room.players = mergedPlayers;
    io.to(roomId).emit('player_list_updated', room.players.map(p => ({ name: p.name, socketId: p.socketId })));
  });

  // 5. RECLAMAR IDENTIDAD
  socket.on('claim_identity', ({ roomId, name }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback(false);

    const playerIndex = room.players.findIndex(p => p.name === name);
    if (playerIndex === -1) return callback(false);
    if (room.players[playerIndex].socketId && room.players[playerIndex].socketId !== socket.id) {
        return callback(false);
    }

    room.players[playerIndex].socketId = socket.id;
    socket.join(roomId);
    
    io.to(roomId).emit('player_list_updated', room.players.map(p => ({ name: p.name, socketId: p.socketId })));
    callback(true);
  });

  // 6. INICIAR JUEGO
  socket.on('game_start', (roomId) => {
      const room = rooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit('game_start'); 
  });

  // 7. REPARTO DE ROLES
  socket.on('distribute_roles', ({ roomId, rolesCount, manualAssignments }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.rolesConfig = rolesCount;

    if (room.gameMode === 'custom' && manualAssignments) {
        let sectTeamAssignments = new Array(room.players.length).fill(null);
        if (rolesCount['sectario'] > 0) {
             const rolesArray = room.players.map(p => manualAssignments[p.id]);
             assignSectTeams(rolesArray, sectTeamAssignments);
        }

        room.players = room.players.map((p, idx) => {
            const roleKey = manualAssignments[p.id] || 'aldeano';
            const status = initializePlayerStatus(roleKey, rolesCount);
            if (sectTeamAssignments[idx]) status.sectTeam = sectTeamAssignments[idx];
            return { ...p, role: roleKey, status };
        });

    } else {
        let deck = [];
        Object.entries(rolesCount).forEach(([role, count]) => {
            for(let i=0; i<count; i++) deck.push(role);
        });
        while(deck.length < room.players.length) deck.push('aldeano');
        
        deck = shuffleArray(deck);

        let sectTeamAssignments = new Array(deck.length).fill(null);
        if (rolesCount['sectario'] > 0) {
             assignSectTeams(deck, sectTeamAssignments);
        }

        room.players = room.players.map((p, idx) => {
            const roleKey = deck[idx];
            const status = initializePlayerStatus(roleKey, rolesCount);
            if (sectTeamAssignments[idx]) status.sectTeam = sectTeamAssignments[idx];
            return { ...p, role: roleKey, status };
        });
    }

    room.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit('role_assigned', { 
                role: p.role, 
                status: p.status,
                playerData: p 
            });
        }
    });

    io.to(room.hostId).emit('full_state_update', { players: room.players });
  });

  // 8. INICIO DE NOCHE
  socket.on('start_night', ({ roomId, dayCount }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.phase = 'night';
    room.dayCount = dayCount;
    room.actions = {}; 
    
    // --- FILTRADO DE COLA (Regla de Noche 0 vs Resto) ---
    const activeQueue = NIGHT_QUEUE_ORDER.filter(roleKey => {
        const isNightZeroRole = ['ladron', 'cupido', 'nino_salvaje'].includes(roleKey);

        // Caso 1: Noche Cero
        if (room.dayCount === 0) {
            // Solo entran los roles de setup inicial si existen y están vivos
            return isNightZeroRole && room.players.some(p => p.role === roleKey && p.alive);
        } 
        
        // Caso 2: Noches Normales (Día 1+)
        else {
            // EXCLUIR explícitamente roles de Noche 0
            if (isNightZeroRole) return false;

            // Lobo Albino: Solo noches pares (2, 4, 6...)
            if (roleKey === 'lobo_albino') {
                return room.players.some(p => p.role === 'lobo_albino' && p.alive) && (room.dayCount % 2 === 0);
            }

            // Lobos normales
            if (roleKey === 'lobos') {
                return room.players.some(p => (p.role === 'lobos' || p.status.isWolf) && p.alive);
            }

            // Resto de roles
            return room.players.some(p => p.role === roleKey && p.alive);
        }
    });

    room.nightQueue = activeQueue;
    room.queueIndex = -1;

    // Elección de Portavoz Lobo
    const wolves = room.players.filter(p => (p.role === 'lobos' || p.status.isWolf) && p.alive);
    if (wolves.length > 0) {
        const randomWolf = wolves[Math.floor(Math.random() * wolves.length)];
        room.wolfSpokesperson = randomWolf.socketId;
    }

    nextTurn(room, io);
  });

  // 9. ACCIÓN NOCTURNA
  socket.on('night_action', ({ roomId, actionData }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.actions = { ...room.actions, ...actionData };

    // Ladrón: Transformación inmediata en Noche 0 para ajustar la cola
    if (actionData.newRole && actionData.thiefId) {
        const pIndex = room.players.findIndex(p => p.id === actionData.thiefId);
        if (pIndex !== -1) {
            const newRole = actionData.newRole;
            room.players[pIndex].role = newRole;
            
            const baseStatus = initializePlayerStatus(newRole, room.rolesConfig);
            room.players[pIndex].status = { ...room.players[pIndex].status, ...baseStatus };
            
            // Si el ladrón elige ser Cupido o Niño Salvaje en Noche 0
            if (room.dayCount === 0) {
                if (['cupido', 'nino_salvaje'].includes(newRole)) {
                    if (!room.nightQueue.includes(newRole)) {
                        room.nightQueue.splice(room.queueIndex + 1, 0, newRole);
                    }
                }
            }

            if (room.players[pIndex].socketId) {
                io.to(room.players[pIndex].socketId).emit('role_update', { 
                    role: newRole, 
                    status: room.players[pIndex].status 
                });
            }
        }
    }

    nextTurn(room, io);
  });

  // 10. VOTACIÓN
  socket.on('start_voting', ({ roomId, type }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.phase = type === 'mayor' ? 'voting_mayor' : 'voting_lynch';
    room.votes = {}; 
    io.to(roomId).emit('start_voting', { type });
  });

  socket.on('cast_vote', ({ roomId, targetId, voterId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.votes[voterId] = targetId;
    io.to(room.hostId).emit('votes_update', room.votes);
  });

  // 11. PUBLICAR RESULTADOS
  socket.on('publish_results', ({ roomId, updatedPlayers, phase, eventData }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players = updatedPlayers;
    room.phase = phase;

    io.to(roomId).emit('game_update', {
        players: room.players,
        phase: phase,
        eventData: eventData
    });
  });

  socket.on('force_action_interaction', ({ roomId, actionData }) => {
     const room = rooms.get(roomId);
     if (room) {
         io.to(room.hostId).emit('force_action_received', actionData);
     }
  });
  
  socket.on('disconnect', () => {
      // Manejo de desconexión
  });
});

// --- FUNCIONES AUXILIARES (DEFINIDAS FUERA DE IO.ON) ---

function nextTurn(room, io) {
    room.queueIndex++;
    
    // FIN DE LA NOCHE
    if (room.queueIndex >= room.nightQueue.length) {
        room.phase = 'day_processing';
        io.to(room.hostId).emit('night_ended', { actions: room.actions });
        io.to(room.id).emit('phase_change', 'day_wait');
        return;
    }

    const currentRole = room.nightQueue[room.queueIndex];
    room.currentTurnRole = currentRole;

    io.to(room.hostId).emit('narrator_turn_update', { role: currentRole });

    room.players.forEach(p => {
        if (!p.socketId) return;

        let status = 'sleeping';
        
        // --- LÓGICA "DEAD MAN WALKING" ---
        if (p.alive) {
            if (currentRole === 'lobos') {
                if (p.role === 'lobos' || p.status.isWolf) {
                    status = (p.socketId === room.wolfSpokesperson) ? 'active' : 'wolf_waiting';
                }
            } 
            else if (currentRole === 'lobos' && p.role === 'nina') {
                 status = 'spy'; 
            }
            else if (p.role === currentRole) {
                status = 'active';
            }
        }

        io.to(p.socketId).emit('turn_change', { 
            status, 
            role: currentRole,
            data: {
                isSpokesperson: p.socketId === room.wolfSpokesperson,
                players: room.players 
            }
        });
    });
}

function createDefaultStatus() {
    return {
        protected: false,
        infected: false,
        charmed: false,
        linked: null,
        mentor: null,
        isWolf: false,
        lives: 1,
        revealed: false,
        extraVotes: 0,
        potions: null,
        fatherWolfUsed: null,
        foxPowerLost: null,
        judgePowerUsed: null,
        cuervoUsed: null,
        thiefChoices: null,
        sectTeam: null,
        tetanus: false
    };
}

function initializePlayerStatus(role, rolesCount) {
    let status = createDefaultStatus();
    
    if (['lobo', 'lobos', 'lobo_albino', 'padre_lobo'].includes(role)) {
        status.isWolf = true;
    }
    if (role === 'anciano') status.lives = 2;
    if (role === 'bruja') status.potions = { life: true, death: true };
    if (role === 'padre_lobo') status.fatherWolfUsed = false;
    if (role === 'zorro') status.foxPowerLost = false;
    if (role === 'juez') status.judgePowerUsed = false;
    if (role === 'cuervo') status.cuervoUsed = false;
    
    if (role === 'ladron') {
        status.thiefChoices = []; 
    }

    return status;
}

function assignSectTeams(rolesArray, assignmentsArray) {
    const sectarioIdx = rolesArray.indexOf('sectario');
    if (sectarioIdx === -1) return;

    const total = rolesArray.length;
    const sectSize = Math.floor(total / 2);
    
    let indices = Array.from({length: total}, (_, i) => i).filter(i => i !== sectarioIdx);
    indices = shuffleArray(indices);
    
    assignmentsArray[sectarioIdx] = 'secta';
    
    for (let i=0; i < sectSize - 1; i++) {
        assignmentsArray[indices[i]] = 'secta';
    }
    for (let i=sectSize - 1; i < indices.length; i++) {
        assignmentsArray[indices[i]] = 'rival';
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor Lobo Online corriendo en puerto ${PORT}`);
});
