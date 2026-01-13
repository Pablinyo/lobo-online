const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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

// --- BASE DE DATOS EN MEMORIA ---
// Estructura: roomId -> { ...estado }
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

// --- SOCKET.IO LÓGICA PRINCIPAL ---
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // 1. CREACIÓN DE SALA
  socket.on('create_room', ({ hostName, system }, callback) => {
    const roomId = generateRoomCode();
    
    rooms.set(roomId, {
      id: roomId,
      hostId: socket.id,
      gameMode: system, // 'standard' (digital) o 'custom' (manual)
      players: [],      // Array ordenado (el orden de registro define los asientos)
      phase: 'lobby',   // phases: lobby, assigning, distributing, game
      dayCount: 0,
      rolesConfig: {},
      nightQueue: [],
      queueIndex: 0,
      currentTurnRole: null,
      wolfSpokesperson: null,
      actions: {},
      votes: {}, // { voterId: targetId } (targetId null = voto en blanco/nulo)
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

  // 3. ACTUALIZAR LISTA DE JUGADORES (Narrador registra nombres)
  // IMPORTANTE: El orden de este array define la disposición de la mesa redonda
  socket.on('update_player_list', ({ roomId, players }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Fusionamos preservando sockets existentes si los hay
    // El frontend manda la lista ordenada según registro
    const mergedPlayers = players.map(newP => {
        const existing = room.players.find(p => p.name === newP.name); // Buscamos por nombre, no ID temporal
        return {
            id: existing ? existing.id : newP.id, // Mantenemos ID estable
            name: newP.name,
            socketId: existing ? existing.socketId : null,
            role: existing ? existing.role : 'aldeano',
            alive: existing ? existing.alive : true,
            status: existing ? existing.status : createDefaultStatus()
        };
    });

    room.players = mergedPlayers;
    
    // Emitimos la lista completa para que todos vean qué sitios están libres
    io.to(roomId).emit('player_list_updated', room.players);
  });

  // 4. RECLAMAR ASIENTO (Jugador se identifica en la lista)
  socket.on('claim_seat', ({ roomId, playerName }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: "Sala no encontrada" });

    const playerIndex = room.players.findIndex(p => p.name === playerName);
    if (playerIndex === -1) return callback({ success: false, msg: "Nombre no encontrado" });
    
    // Evitar robo de asiento
    if (room.players[playerIndex].socketId && room.players[playerIndex].socketId !== socket.id) {
        return callback({ success: false, msg: "Asiento ya ocupado" });
    }

    room.players[playerIndex].socketId = socket.id;
    socket.join(roomId);
    
    // Notificar a todos que el asiento se ha ocupado (se pondrá verde en el lobby)
    io.to(roomId).emit('player_list_updated', room.players);
    callback({ success: true, player: room.players[playerIndex] });
  });

  // 5. INICIAR REPARTO (Desde el Lobby)
  socket.on('start_distribution', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      
      // Si es custom, vamos a asignación manual. Si es standard, vamos a animación de barajar
      const nextPhase = room.gameMode === 'custom' ? 'assigning' : 'distributing';
      room.phase = nextPhase;
      io.to(roomId).emit('phase_change', nextPhase);
  });

  // 6. DISTRIBUCIÓN DE ROLES (Digital o Manual confirmada)
  socket.on('distribute_roles', ({ roomId, rolesCount, manualAssignments }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.rolesConfig = rolesCount;

    if (manualAssignments) {
        // --- MODO PERSONALIZADO ---
        // Lógica Sectario
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
        // --- MODO DIGITAL ---
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

    // EMITIR A CADA JUGADOR SU ROL INDIVIDUALMENTE
    room.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit('role_assigned', { 
                role: p.role, 
                status: p.status,
                playerData: p 
            });
        }
    });

    // Enviar estado completo al Narrador
    io.to(room.hostId).emit('full_state_update', { players: room.players });
    
    // Cambiar fase a "reveal" (para ver la carta)
    io.to(roomId).emit('phase_change', 'reveal');
  });

  // 7. COMENZAR PARTIDA (Tras ver cartas)
  socket.on('game_start', (roomId) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.phase = 'game';
      io.to(roomId).emit('phase_change', 'game');
  });

  // 8. GESTIÓN DE LA NOCHE
  socket.on('start_night', ({ roomId, dayCount }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    handleStartNight(room, dayCount, io);
  });

  socket.on('night_action', ({ roomId, actionData }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Acumular acciones
    room.actions = { ...room.actions, ...actionData };

    // Lógica Ladrón (Cambio de rol en tiempo real)
    if (actionData.newRole && actionData.thiefId) {
        const pIndex = room.players.findIndex(p => p.id === actionData.thiefId);
        if (pIndex !== -1) {
            const newRole = actionData.newRole;
            room.players[pIndex].role = newRole;
            
            // Reinicializar status para el nuevo rol
            const baseStatus = initializePlayerStatus(newRole, room.rolesConfig);
            room.players[pIndex].status = { ...room.players[pIndex].status, ...baseStatus };
            
            // Inyección dinámica en la cola si es Noche 0
            if (room.dayCount === 0) {
                if (['cupido', 'nino_salvaje'].includes(newRole)) {
                    if (!room.nightQueue.includes(newRole)) {
                        room.nightQueue.splice(room.queueIndex + 1, 0, newRole);
                    }
                }
            }

            // Notificar al jugador ladrón de su cambio
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

  // 9. SISTEMA DE VOTACIONES (Día y Linchamiento)
  socket.on('start_voting', ({ roomId, type }) => {
    // type: 'mayor' | 'lynch'
    const room = rooms.get(roomId);
    if (!room) return;

    room.phase = type === 'mayor' ? 'voting_mayor' : 'voting_lynch';
    room.votes = {}; 
    
    // Notificar a todos para que muestren la interfaz de votación
    io.to(roomId).emit('voting_started', { type });
  });

  socket.on('cast_vote', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Identificar votante por socket
    const voter = room.players.find(p => p.socketId === socket.id);
    if (!voter) return;

    // Registrar voto (targetId puede ser null para voto nulo)
    room.votes[voter.id] = targetId;
    
    // Enviar progreso al Narrador (quién ha votado, no qué ha votado si es secreto, o todo si es público)
    // Para simplificar, enviamos el estado de los votos al Narrador para que él calcule
    io.to(room.hostId).emit('votes_update', room.votes);
  });

  socket.on('close_voting', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      // Narrador decide cerrar y calcular
      // El cálculo se hace en el frontend del narrador y se emite publish_results
  });

  // 10. PUBLICAR RESULTADOS Y ACTUALIZAR ESTADO GLOBAL
  // Se usa para: Amanecer, Resultado Votación, Eventos (Cazador, etc.)
  socket.on('publish_results', ({ roomId, players, phase, eventData }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players = players;
    if (phase) room.phase = phase;

    // Broadcast a todos
    io.to(roomId).emit('game_update', {
        players: room.players,
        phase: room.phase,
        eventData: eventData // Para modales específicos (muerte, victoria, etc.)
    });
  });

  // 11. GESTIÓN DE EVENTOS ESPECIALES (Disparos, revivir, etc.)
  socket.on('trigger_special_event', ({ roomId, eventType, payload }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      
      // Reenvía el evento a todos para que muestren modales (ej: "Has muerto", "Cazador dispara")
      io.to(roomId).emit('special_event', { type: eventType, payload });
  });

  socket.on('disconnect', () => {
    // Opcional: Notificar desconexión en el lobby
    // Recorrer rooms para encontrar al socket y marcarlo
  });
});

// --- FUNCIONES LÓGICAS ---

function handleStartNight(room, dayCount, io) {
    room.phase = 'night';
    room.dayCount = dayCount !== undefined ? dayCount : room.dayCount;
    room.actions = {}; 
    
    const activeQueue = NIGHT_QUEUE_ORDER.filter(roleKey => {
        const isNightZeroRole = ['ladron', 'cupido', 'nino_salvaje'].includes(roleKey);

        if (room.dayCount === 0) {
            return isNightZeroRole && room.players.some(p => p.role === roleKey && p.alive);
        } else {
            if (isNightZeroRole) return false;
            if (roleKey === 'lobo_albino') {
                return room.players.some(p => p.role === 'lobo_albino' && p.alive) && (room.dayCount % 2 === 0);
            }
            if (roleKey === 'lobos') {
                return room.players.some(p => (p.role === 'lobos' || p.status.isWolf) && p.alive);
            }
            return room.players.some(p => p.role === roleKey && p.alive);
        }
    });

    room.nightQueue = activeQueue;
    room.queueIndex = -1;

    // Elegir Portavoz Lobo
    const wolves = room.players.filter(p => (p.role === 'lobos' || p.status.isWolf) && p.alive);
    if (wolves.length > 0) {
        const randomWolf = wolves[Math.floor(Math.random() * wolves.length)];
        room.wolfSpokesperson = randomWolf.socketId;
    } else {
        room.wolfSpokesperson = null;
    }

    nextTurn(room, io);
}

function nextTurn(room, io) {
    room.queueIndex++;
    
    if (room.queueIndex >= room.nightQueue.length) {
        room.phase = 'day_processing';
        // Enviar todas las acciones al Narrador para que calcule muertes
        io.to(room.hostId).emit('night_ended', { actions: room.actions });
        // Poner a los jugadores en espera
        io.to(room.id).emit('phase_change', 'day_wait'); 
        return;
    }

    const currentRole = room.nightQueue[room.queueIndex];
    room.currentTurnRole = currentRole;

    // Avisar al narrador de quién es el turno
    io.to(room.hostId).emit('narrator_turn_update', { role: currentRole });

    // Avisar a los jugadores
    room.players.forEach(p => {
        if (!p.socketId) return;

        let status = 'sleeping'; // Estado por defecto: Pantalla genérica "Durmiendo..."
        
        if (p.alive) {
            if (currentRole === 'lobos') {
                if (p.role === 'lobos' || p.status.isWolf) {
                    status = (p.socketId === room.wolfSpokesperson) ? 'active' : 'wolf_waiting';
                }
            } 
            else if (currentRole === 'lobos' && p.role === 'nina') {
                 status = 'spy'; // La Niña espía
            }
            else if (p.role === currentRole) {
                status = 'active'; // ¡Es tu turno! Muestra el modal
            }
        }

        io.to(p.socketId).emit('turn_change', { 
            status, 
            role: currentRole,
            data: {
                isSpokesperson: p.socketId === room.wolfSpokesperson,
                players: room.players // Para que puedan elegir objetivo
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
    
    if (role === 'ladron') status.thiefChoices = []; 

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
