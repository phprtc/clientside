interface LooseObject {
    [key: string]: any
}

interface RTC_WSEvent {
    time: number
    event: string
    status: number
    data: {
        message: string
        reason?: string
        sender_type: string
        sender_sid?: string
    }
    sender: {
        type: string
        id: string
        info?: any
    }
    receiver: {
        type: string
        id: string
    }
    meta?: LooseObject
}

class RTC_EventEmitter {
    listeners: {};

    constructor() {
        this.listeners = {
            'on': {},
            'once': {}
        }
    }

    on(name: string, listener: CallableFunction): void {
        if (!this.listeners['on'][name]) {
            this.listeners['on'][name] = [];
        }

        this.listeners['on'][name].push(listener);
    }

    once(name: string, listener: CallableFunction): void {
        if (!this.listeners['once'][name]) {
            this.listeners['once'][name] = [];
        }

        this.listeners['once'][name].push(listener);
    }

    dispatch(name: string, data: any[] = []): void {
        let regularEvent = this.listeners['on'];
        if (regularEvent.hasOwnProperty(name)) {
            regularEvent[name].forEach(function (listener) {
                listener(...data)
            });
        }

        let onceEvent = this.listeners['once'];
        if (onceEvent.hasOwnProperty(name)) {
            onceEvent[name].forEach(function (listener) {
                listener(data);
            });

            delete onceEvent[name];
        }
    }
}

class RTC_Room {
    constructor(
        public readonly name: string,
        private readonly connection: RTC_Websocket,
        private readonly eventEmitter = new RTC_EventEmitter()
    ) {
        const joinRoom = () => this.connection.send('room_join', name, {
            type: 'room',
            id: this.name,
        });

        if (this.connection.isOpened()) {
            joinRoom()
        } else {
            this.connection.onOpen(joinRoom)
        }
    }

    onJoined(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on('room_joined', listener)
        return this
    }

    onUserJoined(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on('room_user_joined', listener)
        return this
    }

    onUserLeft(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on('room_user_left', listener)
        return this
    }

    onWelcome(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on('room_welcome', listener)
        return this
    }

    onMessage(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on('room_message', listener)
        return this
    }

    on(name: string, listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.on(name, listener)
        return this
    }

    once(name: string, listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.eventEmitter.once(name, listener)
        return this
    }

    onAllEvents(listener: (event: RTC_WSEvent) => void): RTC_Room {
        this.on('all_events', listener);
        return this
    }

    send(event: string, data: any) {
        return this.connection.send(event, data, {
            type: 'room',
            id: this.name,
        })
    }

    sendMessage(message: string) {
        return this.send('room_message', message);
    }

    leave(reason = 'conn_close') {
        return this.connection.send('room_leave', {reason}, {
            type: 'room',
            id: this.name,
        })
    }

    getConnection(): RTC_Websocket {
        return this.connection;
    }

    emitEvent(name: string, event: RTC_WSEvent): void {
        this.eventEmitter.dispatch(name, [event])
    }
}

class RTC_Websocket {
    private websocket: WebSocket;
    private reconnectionInterval: number = 5_000;
    private connectionState: string = 'standby';
    private willReconnect: boolean = true;
    private canReconnect: boolean = true;
    private eventEmitter: RTC_EventEmitter;

    private defaultAuthToken: string | null = null;
    private reconnectionTimeout: NodeJS.Timeout;
    private rooms: RTC_Room[] = []
    private isClientPingEnabled = false
    private pingPongInterval: number = 20_000;
    private pingPongIntervalTimer: NodeJS.Timer;

    static create(uri: string, options: any[] = [], user_info?: LooseObject) {
        const ws = (new RTC_Websocket(uri, options, user_info)).connect()

        if (user_info) {
            ws.onOpen(() => ws.attachInfo(user_info))
        }

        return ws;
    }

    constructor(
        private wsUri: string,
        private options: any[] = [],
        private user_info?: LooseObject,
    ) {
        this.eventEmitter = new RTC_EventEmitter();

        // HANDLE MESSAGE/EVENT DISPATCH WHEN DOM FINISHED LOADING
        // Inspect messages and dispatch event
        this.onMessage((event) => {
            if (event.event) {
                // Dispatch unfiltered event events
                this.eventEmitter.dispatch('event', [event]);

                // Dispatch filtered event event
                this.eventEmitter.dispatch('event.' + event.event, [event]);

                // Handle server intentional disconnection
                if (event.event === 'conn.rejected') {
                    this.stopPingPong()
                    this.stopReconnectionTimeout()
                    this.canReconnect = false

                    this.log(`Server rejected connection: ${this.wsUri}.\nReason: ${event.data.reason}`)
                    return;
                }

                // Handle Room Events
                if (event.receiver.type === 'room') {
                    for (let i = 0; i < this.rooms.length; i++) {
                        const room = this.rooms[i]
                        if (room.name === event.receiver.id) {
                            room.emitEvent('all_events', event)
                            room.emitEvent(event.event, event)
                            break;
                        }
                    }
                }
            }
        });
    }


    /**
     * Check if connection is opened
     * @returns {boolean}
     */
    isOpened(): boolean {
        return 'open' === this.connectionState;
    };

    /**
     * Gets server connection state
     * @returns {string}
     */
    getState(): string {
        return this.connectionState;
    };

    /**
     * Get browser implementation of WebSocket object
     * @return {WebSocket}
     */
    getWebSocket(): WebSocket {
        return this.websocket
    };

    /**
     * This event fires when a connection is opened/created
     * @param listener
     */
    onOpen(listener: () => void): RTC_Websocket {
        this.eventEmitter.on('open', listener);
        return this;
    };

    attachInfo(info: LooseObject): RTC_Websocket {
        this.send('attach_info', info, {
            type: 'server',
            id: 'server'
        });

        return this;
    };

    joinRoom(name: string): RTC_Room {
        const room = new RTC_Room(name, this);
        this.rooms.push(room)
        return room
    };

    leaveRoom(name: string): void {
        for (let i = 0; i < this.rooms.length; i++) {
            const room = this.rooms[i]
            if (room.name === name) {
                room.leave().then(() => this.rooms.splice(i, 1))
                break;
            }
        }
    }

    getRoom(name: string): RTC_Room | null {
        for (let i = 0; i < this.rooms.length; i++) {
            const room = this.rooms[i]
            if (room.name === name) {
                return room
            }
        }

        return null
    }

    setPingPongInterval(ms: number): RTC_Websocket {
        this.pingPongInterval = ms
        this.stopPingPong()

        if (this.isClientPingEnabled && this.isOpened()) {
            this.startPingPong()
        }

        return this
    }

    enableClientPing(): RTC_Websocket {
        this.isClientPingEnabled = true
        return this
    }

    /**
     * This event fires when message is received
     * @param listener
     */
    onMessage(listener: (event: RTC_WSEvent) => void): RTC_Websocket {
        this.eventEmitter.on('message', listener);
        return this;
    };

    /**
     * Listens to filtered websocket event message
     *
     * @param event {string}
     * @param listener {callback}
     */
    onEvent(event: string, listener: (event: RTC_WSEvent) => void): RTC_Websocket {
        this.eventEmitter.on('event.' + event, listener);
        return this;
    };

    /**
     * Listens to RTC socket event
     *
     * @param listener
     */
    onAnyEvent(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('event', listener);
        return this;
    };

    /**
     * This event fires when this connection is closed
     *
     * @param listener
     */
    onClose(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('close', listener);
        return this;
    };

    /**
     * This event fires when client is disconnecting this connection
     *
     * @param listener
     */
    onDisconnect(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('custom.disconnect', listener);
        return this;
    };

    /**
     * This event fires when an error occurred
     * @param listener
     */
    onError(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('error', listener);
        return this;
    };

    /**
     * This event fires when this connection is in connecting state
     * @param listener
     */
    onConnecting(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('connecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection is in connecting state
     * @param listener
     */
    onReconnecting(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('reconnecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection has been reconnected
     * @param listener
     */
    onReconnect(listener: CallableFunction): RTC_Websocket {
        this.eventEmitter.on('reconnect', listener);
        return this;
    };


    onReady(listener): void {
        window.addEventListener('DOMContentLoaded', listener);
    };

    /**
     * Set reconnection interval
     * @param interval
     */
    setReconnectionInterval(interval: number): RTC_Websocket {
        this.reconnectionInterval = interval;
        return this;
    };

    /**
     * Set an authentication token that will be included in each outgoing message
     *
     * @param token {string} authentication token
     */
    setAuthToken(token: string): RTC_Websocket {
        this.defaultAuthToken = token;
        return this;
    };


    /**
     * Manually reconnect this connection
     */
    reconnect(): void {
        if (this.canReconnect) {
            this.closeConnection(true);

            if (this.reconnectionInterval) {
                this.reconnectionTimeout = setTimeout(
                    () => this.createSocket(true),
                    this.reconnectionInterval
                );
            }
        }
    };

    /**
     * Connect to websocket server
     *
     * @returns {RTC_Websocket}
     */
    connect(): RTC_Websocket {
        // Create websocket connection
        this.createSocket();

        return this;
    };

    /**
     * Close this connection, the connection will not be reconnected.
     */
    close() {
        this.willReconnect = false;
        this.stopPingPong()
        this.stopReconnectionTimeout()

        // Leave Rooms First
        this.rooms.forEach(room => room.leave())

        setImmediate(() => {
            this.closeConnection(false)
            this.eventEmitter.dispatch('custom.disconnect');
        })
    };


    /**
     * Send message to websocket server
     * @param event {any} event name
     * @param data {array|object|int|float|string} message
     * @param receiver {LooseObject}
     * @return Promise
     */
    send(event: string, data: any, receiver: LooseObject = {}): Promise<any> {
        event = JSON.stringify({
            event: event,
            data: data,
            receiver: receiver,
            time: new Date().getTime(),
        });

        //Send message
        return new Promise((resolve, reject) => {
            //Only send message when client is connected
            if (this.isOpened()) {
                try {
                    this.websocket.send(event);
                    resolve(this);
                } catch (error) {
                    reject(error);
                }

                //Send message when connection is recovered
            } else {
                this.log(`Your message will be sent when server connection is recovered, server:${this.wsUri}`);
                this.eventEmitter.once('open', () => {
                    try {
                        this.websocket.send(event);
                        resolve(this);
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        })
    };

    private sendToSystem(event: string, data: any) {
        return this.send(event, data, {
            type: 'system',
            id: 'system'
        })

    }

    private log(message: any): void {
        console.log(message);
    };

    private startPingPong(): void {
        this.pingPongIntervalTimer = setInterval(() => {
            this.sendToSystem('ping', {message: 'ping'})
        }, this.pingPongInterval)
    }

    private stopPingPong(): void {
        clearInterval(this.pingPongIntervalTimer);
    }

    private stopReconnectionTimeout() {
        clearTimeout(this.reconnectionTimeout);
    }

    private changeState(stateName: string, event: any[]): void {
        this.connectionState = stateName;

        if ('close' === stateName && this.willReconnect) {
            this.reconnect();
        }

        this.eventEmitter.dispatch(stateName, [event]);
    };

    private closeConnection(reconnect: boolean = false, reason = 'general'): void {
        if (reconnect) {
            this.willReconnect = true;
            this.connectionState = 'internal_reconnection';
        }

        if (this.isOpened()) {
            this.sendToSystem('conn_close', {reason});
        }

        setImmediate(() => this.websocket.close());
    };

    private closeNativeWebsocketConnection(): void {
        if (this.websocket) {
            if (this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.close()
            }

            if (this.websocket.readyState === WebSocket.CONNECTING) {
                let interval = setInterval(() => {
                    if (this.websocket.readyState === WebSocket.OPEN) {
                        this.websocket.close()
                        clearInterval(interval);
                    }
                }, 250)
            }
        }
    }

    private createSocket(isReconnecting: boolean = false): void {
        if (isReconnecting) {
            this.connectionState = 'reconnecting';
            this.eventEmitter.dispatch('reconnecting');
        } else {
            this.connectionState = 'connecting';
            this.eventEmitter.dispatch('connecting');

        }

        if (this.wsUri.indexOf('ws://') === -1 && this.wsUri.indexOf('wss://') === -1) {
            this.wsUri = 'ws://' + window.location.host + this.wsUri;
        }

        this.closeNativeWebsocketConnection()

        this.websocket = new WebSocket(this.wsUri, []);

        this.websocket.addEventListener('open', (...args) => {
            if (this.defaultAuthToken) {
                this.send('auth.token', this.defaultAuthToken)
            }

            if ('reconnecting' === this.connectionState) {
                this.eventEmitter.dispatch('reconnect');
            }

            // Ping pong
            if (this.isClientPingEnabled) {
                this.startPingPong();
            }

            this.changeState('open', args);
        });

        this.websocket.addEventListener('message', (e: MessageEvent) => {
            let event: RTC_WSEvent = JSON.parse(e.data);

            if (event.event === 'pong') {
                return;
            }

            if (event.event === 'ping') {
                this.sendToSystem('pong', {message: 'pong'});
                return;
            }

            // User Info needs double parsing
            if (event.sender.info) {
                event.sender.info = JSON.parse(event.sender.info)
            }

            // User Info needs double parsing
            if (event.meta && event.meta.user_info) {
                event.meta.user_info = JSON.parse(event.meta.user_info)
            }

            this.eventEmitter.dispatch('message', [event]);
        });

        this.websocket.addEventListener('close', (...args) => {
            this.stopPingPong()
            this.changeState('close', args);
        });

        this.websocket.addEventListener('error', (...args) => {
            this.changeState('error', args);
        });
    }
}
