// =================================================================================
// 🐺 SERVIDOR MAESTRO: HOMBRES LOBO DE CASTRONEGRO ONLINE 🐺
// =================================================================================

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- ESTADO GLOBAL ---
const rooms = {};

// --- UTILIDADES ---
const shuffle = (array) => {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
};

// --- LÓGICA DEL DOMADOR DE OSOS ---
const checkBearGrowl = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    
    const alivePlayers = room.players.filter(p => p.alive);
    const tamer = alivePlayers.find(p => p.role === 'domador');
    
    // El domador solo funciona si está vivo y no está infectado
    if (tamer && !tamer.attributes.infected) { 
        const tamerIndex = alivePlayers.indexOf(tamer);
        const total = alivePlayers.length;
        
        // Vecinos circulares (solo vivos)
        const left = alivePlayers[(tamerIndex - 1 + total) % total];
        const right = alivePlayers[(tamerIndex + 1) % total];
        
        const isWolf = (p) => p.role === 'lobo' || p.role === 'lobo_albino' || p.role === 'padre_lobo' || p.attributes.infected || p.attributes.isWolf;

        if (isWolf(left) || isWolf(right)) {
            io.to(roomCode).emit('bear_growl'); // Sonido general
            io.to(tamer.socketId).emit('bear_growl_personal'); // Modal al domador
            io.to(room.hostId).emit('narrator_info', { message: "🐻 El Oso ha gruñido (Lobo adyacente)." });
        }
    }
};

// --- FUNCIÓN CRÍTICA: MATAR JUGADOR ---
const killPlayer = (roomCode, playerId, cause = "generic") => {
    const room = rooms[roomCode];
    if (!room) return;
    const victim = room.players.find(p => p.id === playerId);
    
    if (!victim || !victim.alive) return;

    // 1. Ejecutar muerte
    victim.alive = false;
    console.log(`💀 MUERTE en ${roomCode}: ${victim.name} (${cause})`);
    io.to(roomCode).emit('player_killed', { playerId: victim.id, cause });

    // 2. REGLA CUPIDO (Corazón Roto)
    if (victim.linkedTo) {
        const partner = room.players.find(p => p.id === victim.linkedTo);
        if (partner && partner.alive) {
            partner.alive = false;
            io.to(roomCode).emit('force_heartbreak', { 
                victimName: victim.name, 
                partnerName: partner.name 
            });
            // Si el partner era cazador, activar venganza
            if (partner.role === 'cazador') {
                setTimeout(() => io.to(partner.socketId).emit('hunter_revenge_trigger'), 2500);
            }
        }
    }

    // 3. REGLA NIÑO SALVAJE
    room.players.forEach(p => {
        if (p.role === 'nino_salvaje' && p.attributes.mentor === victim.id) {
            p.attributes.isWolf = true; 
            io.to(p.socketId).emit('wild_child_transform');
            io.to(room.hostId).emit('narrator_info', { message: `🐺 El Niño Salvaje (${p.name}) se ha transformado en Lobo.` });
        }
    });

    // 4. REGLA CABALLERO ESPADA OXIDADA
    if (victim.role === 'caballero' && cause === 'lobos' && !victim.attributes.infected) {
        io.to(room.hostId).emit('narrator_info', { message: "⚔️ El Caballero ha muerto devorado. El lobo a su izquierda debe morir mañana por Tétanos." });
    }

    // 5. REGLA CAZADOR
    if (victim.role === 'cazador') {
        io.to(victim.socketId).emit('hunter_revenge_trigger');
    }

    // 6. REGLA ANCIANO (Pérdida de poderes)
    // Según tu petición: Solo si el cazador le dispara o linchamiento (opcional, aquí pongo cazador estricto según petición)
    if (victim.role === 'anciano' && cause === 'Disparo del Cazador') {
         io.to(room.hostId).emit('narrator_info', { message: "⚠️ El Cazador mató al Anciano. ¡El pueblo pierde sus poderes!" });
         io.to(roomCode).emit('ancient_death_penalty'); // Frontend desactiva habilidades
    }

    checkVictoryCondition(roomCode);
};

// NUEVA FUNCIÓN: Revivir a un jugador (Bruja)
const revivePlayer = (roomCode, playerId) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    if (!player.alive) {
        player.alive = true;
        io.to(roomCode).emit('player_revived', { playerId: player.id });
    }
};

const checkVictoryCondition = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const alive = room.players.filter(p => p.alive);
    
    const wolves = alive.filter(p => 
        p.role === 'lobo' || p.role === 'lobo_albino' || p.role === 'padre_lobo' || 
        p.attributes.infected || p.attributes.isWolf
    );
    const villagers = alive.filter(p => !wolves.includes(p));

    // Victoria Enamorados
    if (alive.length === 2 && alive[0].linkedTo === alive[1].id) {
        const p1IsWolf = wolves.includes(alive[0]);
        const p2IsWolf = wolves.includes(alive[1]);
        if (p1IsWolf !== p2IsWolf) {
             io.to(roomCode).emit('game_over', { winner: 'lovers', message: '¡El Amor Prohibido ha ganado!' });
             return;
        }
    }

    if (wolves.length === 0 && villagers.length > 0) {
        io.to(roomCode).emit('game_over', { winner: 'villagers', message: '¡El Pueblo ha vencido!' });
    } else if (wolves.length >= villagers.length) {
        io.to(roomCode).emit('game_over', { winner: 'wolves', message: '¡Los Lobos han ganado!' });
    } else if (alive.length === 0) {
        io.to(roomCode).emit('game_over', { winner: 'nobody', message: 'Todos han muerto...' });
    }
};

// --- SOCKETS ---
io.on('connection', (socket) => {
    console.log('🟢 Conectado:', socket.id);

    // 1. SALA
    socket.on('create_room', (data, callback) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        const hostName = typeof data === 'object' ? (data.hostName || data.narratorName) : data;
        
        rooms[roomCode] = {
            hostId: socket.id,
            hostName: hostName,
            players: [],
            phase: 'lobby',
            votes: {},
            centerCards: [] // Para el ladrón
        };
        socket.join(roomCode);
        if (callback) callback({ roomCode });
    });

    socket.on('check_room', ({ roomCode }, callback) => {
        callback({ valid: !!rooms[roomCode] });
    });

    socket.on('update_player_list', ({ roomCode, players }) => {
        if (!rooms[roomCode]) return;
        const oldPlayers = rooms[roomCode].players;
        rooms[roomCode].players = players.map(newP => {
            const existing = oldPlayers.find(old => old.name === newP.name);
            return {
                id: newP.id || Date.now() + Math.random(),
                name: newP.name,
                socketId: existing ? existing.socketId : null,
                role: existing ? existing.role : null,
                alive: existing ? existing.alive : true,
                seenRole: existing ? existing.seenRole : false,
                linkedTo: existing ? existing.linkedTo : null,
                attributes: existing ? existing.attributes : {}
            };
        });
        io.to(roomCode).emit('player_list_updated', rooms[roomCode].players);
    });

    socket.on('get_available_identities', ({ roomCode }, cb) => {
        if (rooms[roomCode]) cb({ identities: rooms[roomCode].players });
        else cb({ identities: [] });
    });

    socket.on('claim_identity', ({ roomCode, playerId }, cb) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        if (player) {
            player.socketId = socket.id;
            socket.join(roomCode);
            io.to(roomCode).emit('player_list_updated', room.players);
            
            // Reconexión
            if (room.phase !== 'lobby') {
                socket.emit('reconnect_state', { role: player.role, alive: player.alive });
            }
            if (cb) cb({ success: true });
        } else {
            if (cb) cb({ success: false });
        }
    });

    // 2. REPARTO
    socket.on('distribute_roles_digital', ({ roomCode, rolesSettings }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        let deck = [];
        Object.entries(rolesSettings).forEach(([role, count]) => {
            for(let i=0; i<count; i++) deck.push(role);
        });
        
        // Rellenar con aldeanos si faltan, o dejar sobrantes para el ladrón
        while(deck.length < room.players.length) deck.push('aldeano');
        
        deck = shuffle(deck);

        // Asignar roles a jugadores
        room.players.forEach((p, i) => {
            p.role = deck[i] || 'aldeano';
            p.alive = true;
            p.seenRole = false;
            p.attributes = {};
            if (p.socketId) io.to(p.socketId).emit('start_role_animation', { role: p.role });
        });

        // Guardar cartas sobrantes para el Ladrón
        if (deck.length > room.players.length) {
            room.centerCards = deck.slice(room.players.length);
        } else {
            room.centerCards = ['aldeano', 'aldeano']; // Fallback
        }

        room.phase = 'setup';
        socket.emit('narrator_waiting_ack'); 
    });

    socket.on('distribute_roles_manual', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        io.to(roomCode).emit('manual_distribution_start');
        room.phase = 'setup';
    });
    
    socket.on('manual_roles_assigned', ({ roomCode, playersWithRoles }) => {
        const room = rooms[roomCode];
        playersWithRoles.forEach(pWR => {
            const p = room.players.find(x => x.id === pWR.id);
            if (p) {
                p.role = pWR.role;
                p.alive = true;
                p.seenRole = true; 
                if(p.socketId) io.to(p.socketId).emit('role_assigned_manual', { role: p.role });
            }
        });
        socket.emit('distribution_completed', room.players);
    });

    socket.on('ack_role_seen', ({ roomCode, playerId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(x => x.id === playerId);
        if (p) p.seenRole = true;
        io.to(room.hostId).emit('player_ack_update', { playerId });
        if (room.players.every(pl => pl.seenRole)) {
            io.to(room.hostId).emit('all_roles_seen');
        }
    });

    socket.on('start_game_process', ({ roomCode }) => {
        io.to(roomCode).emit('game_started');
        checkBearGrowl(roomCode);
    });

    // 4. TURNOS DE NOCHE
    socket.on('trigger_turn', ({ roomCode, roleToWake }) => {
        const room = rooms[roomCode];
        if (!room) return;

        io.to(roomCode).emit('sleep'); // Todos duermen

        if (roleToWake === 'lobos') {
            const wolves = room.players.filter(p => 
                (p.role === 'lobo' || p.role === 'lobo_albino' || p.role === 'padre_lobo' || p.attributes.infected || p.attributes.isWolf) 
                && p.alive
            );
            
            if (wolves.length > 0) {
                // ELEGIR PORTAVOZ ALEATORIO CADA NOCHE
                const spokesperson = wolves[Math.floor(Math.random() * wolves.length)];
                
                wolves.forEach(w => {
                    if (w.id === spokesperson.id) {
                        io.to(w.socketId).emit('wake_up_action', { role: 'lobo', isSpokesperson: true });
                    } else {
                        io.to(w.socketId).emit('wake_up_passive', { role: 'lobo', spokespersonName: spokesperson.name });
                    }
                });
            } else {
                io.to(room.hostId).emit('turn_info', { message: "No hay lobos vivos." });
            }
        } 
        else if (roleToWake === 'ladron') {
            // Ladrón recibe las cartas sobrantes
            const thief = room.players.find(p => p.role === 'ladron' && p.alive);
            if (thief) {
                 io.to(thief.socketId).emit('wake_up_action', { role: 'ladron', centerCards: room.centerCards });
            }
        }
        else {
            const targets = room.players.filter(p => p.role === roleToWake);
            targets.forEach(p => {
                if (p.alive) {
                    io.to(p.socketId).emit('wake_up_action', { role: roleToWake });
                } else {
                    io.to(p.socketId).emit('wake_up_dead', { role: roleToWake });
                }
            });
        }
    });

    // Acciones de roles
    socket.on('action_performed', ({ roomCode, action, targetId, extraData }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (action === 'cupid_link') {
            const { p1Id, p2Id } = extraData;
            const p1 = room.players.find(p => p.id === p1Id);
            const p2 = room.players.find(p => p.id === p2Id);
            if (p1 && p2) {
                p1.linkedTo = p2.id;
                p2.linkedTo = p1.id;
                io.to(p1.socketId).emit('you_are_in_love', { partnerName: p2.name });
                io.to(p2.socketId).emit('you_are_in_love', { partnerName: p1.name });
            }
        }

        if (action === 'wild_child_mentor') {
            const child = room.players.find(p => p.socketId === socket.id);
            if (child) child.attributes.mentor = targetId;
        }

        if (action === 'thief_swap') {
             // El ladrón cambia su rol en el servidor
             const thief = room.players.find(p => p.socketId === socket.id);
             if (thief && extraData.newRole) {
                 thief.role = extraData.newRole;
                 console.log(`Ladrón cambió a: ${thief.role}`);
                 // Actualizamos su carta en el frontend
                 socket.emit('role_assigned_manual', { role: thief.role });
             }
        }
        
        io.to(room.hostId).emit('narrator_action_report', { action, targetId, extraData });
    });

    // 5. VOTACIONES
    socket.on('start_voting', ({ roomCode, type }) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.phase = 'voting';
        room.votes = {};
        io.to(roomCode).emit('show_voting_screen', { 
            candidates: room.players.filter(p => p.alive),
            type,
            allowNull: type === 'lynch' // Linchamiento permite nulo
        });
    });

    socket.on('cast_vote', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.votes[socket.id] = targetId;
        
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(roomCode).emit('voting_update', { counts });
    });

    socket.on('close_voting', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        
        let max = 0;
        let winners = [];
        Object.entries(counts).forEach(([id, c]) => {
            if (c > max) { max = c; winners = [id]; }
            else if (c === max) winners.push(id);
        });

        // REGLA CABEZA DE TURCO: Si hay empate en linchamiento y hay un cabeza de turco vivo, muere él
        if (room.phase === 'voting' && winners.length > 1) { // Empate
             const scapegoat = room.players.find(p => p.role === 'cabeza_turco' && p.alive);
             if (scapegoat) {
                 io.to(room.hostId).emit('narrator_info', { message: "⚖️ Empate. El Cabeza de Turco muere por ello." });
                 // El narrador confirmará la muerte en el frontend, o podríamos hacerlo automático:
                 // killPlayer(roomCode, scapegoat.id, "Cabeza de Turco (Empate)");
                 // Dejamos que el frontend lo sugiera al Narrador.
             }
        }

        io.to(room.hostId).emit('voting_result', { winners, counts, isTie: winners.length > 1 });
        io.to(roomCode).emit('hide_voting_screen');
    });

    // 6. EVENTOS FINALES
    socket.on('hunter_revenge_shot', ({ roomCode, targetId }) => {
        killPlayer(roomCode, targetId, "Disparo del Cazador");
        io.to(roomCode).emit('player_revived', { playerId: 'ALL' }); 
    });

    socket.on('confirm_death_manual', ({ roomCode, playerId, cause }) => {
        killPlayer(roomCode, playerId, cause || "Narrador");
    });
    
    socket.on('revive_player', ({ roomCode, playerId }) => {
        revivePlayer(roomCode, playerId);
    });

    socket.on('game_reset', ({ roomCode, fullExit }) => {
        if (fullExit) delete rooms[roomCode];
        io.to(roomCode).emit('reset_game', { fullExit });
    });

    socket.on('disconnect', () => { /* Log */ });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SERVIDOR LOBO ACTIVO: ${PORT}`));
