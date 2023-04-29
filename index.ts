interface LooseObject {
    [key: string]: any
}

interface WSEvent {
    event: string
    time: number
    data: {
        message: string
        sender_type: string
        sender_sid?: string
    }
    meta?: LooseObject
}

class RTC_Event {
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
    private readonly connection: RTC_Websocket

    constructor(
        private wsUri: string,
        private name: string
    ) {
        this.connection = new RTC_Websocket(wsUri).connect()
        this.connection.onOpen(() => {
            this.connection.send('join', name, {
                type: 'room',
                name: this.name,
            })
        })
    }

    onMessage(listener: (event: WSEvent) => void): RTC_Room {
        this.connection.onMessage(listener)
        return this
    }

    onEvent(name: string, listener: (event: WSEvent) => void): RTC_Room {
        this.connection.onEvent(name, listener)
        return this
    }

    send(data: any) {
        return this.connection.send('message', data, {
            type: 'room',
            name: this.name,
        })
    }

    leave() {
        return this.connection.send('leave', null, {
            type: 'room',
            name: this.name,
        })
    }

    getConnection(): RTC_Websocket {
        return this.connection;
    }
}

class RTC_Websocket {
    private websocket: WebSocket;
    private reconnectionInterval: number = 1000;
    private connectionState: string = 'standby';
    private willReconnect: boolean = true;
    private event: RTC_Event;

    private defaultAuthToken: string | null = null;
    private reconnectionTimeout: NodeJS.Timeout;

    constructor(
        private wsUri: string,
        private options: any[] = []
    ) {
        this.event = new RTC_Event();

        // HANDLE MESSAGE/EVENT DISPATCH WHEN DOM FINISHED LOADING
        // Inspect messages and dispatch event
        this.onMessage((payload) => {
            if (payload.event) {
                // Dispatch unfiltered event events
                this.event.dispatch('event', [payload]);

                // Dispatch filtered event event
                this.event.dispatch('event.' + payload.event, [payload]);
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
        this.event.on('open', listener);
        return this;
    };

    /**
     * This event fires when message is received
     * @param listener
     */
    onMessage(listener: (event: any) => void): RTC_Websocket {
        this.event.on('message', (payload: any) => {
            if ('string' === typeof payload.data) {
                listener(JSON.parse(payload.data))
            } else {
                listener(payload);
            }
        });

        return this;
    };

    /**
     * Listens to filtered websocket event message
     *
     * @param event {string}
     * @param listener {callback}
     */
    onEvent(event: string, listener: (event: WSEvent) => void): RTC_Websocket {
        this.event.on('event.' + event, listener);
        return this;
    };

    /**
     * Listens to RTC socket event
     *
     * @param listener
     */
    onAnyEvent(listener: CallableFunction): RTC_Websocket {
        this.event.on('event', listener);
        return this;
    };

    /**
     * This event fires when this connection is closed
     *
     * @param listener
     */
    onClose(listener: CallableFunction): RTC_Websocket {
        this.event.on('close', listener);
        return this;
    };

    /**
     * This event fires when client is disconnecting this connection
     *
     * @param listener
     */
    onDisconnect(listener: CallableFunction): RTC_Websocket {
        this.event.on('custom.disconnect', listener);
        return this;
    };

    /**
     * This event fires when an error occurred
     * @param listener
     */
    onError(listener: CallableFunction): RTC_Websocket {
        this.event.on('error', listener);
        return this;
    };

    /**
     * This event fires when this connection is in connecting state
     * @param listener
     */
    onConnecting(listener: CallableFunction): RTC_Websocket {
        this.event.on('connecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection is in connecting state
     * @param listener
     */
    onReconnecting(listener: CallableFunction): RTC_Websocket {
        this.event.on('reconnecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection has been reconnected
     * @param listener
     */
    onReconnect(listener: CallableFunction): RTC_Websocket {
        this.event.on('reconnect', listener);
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
        this.closeConnection(true);

        if (this.reconnectionInterval) {
            this.reconnectionTimeout = setTimeout(
                () => this.createSocket(true),
                this.reconnectionInterval
            );
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
        this.closeConnection(false)
        clearTimeout(this.reconnectionTimeout);
        this.event.dispatch('custom.disconnect');
    };


    /**
     * Send message to websocket server
     * @param event {any} event name
     * @param message {array|object|int|float|string} message
     * @param receiver {LooseObject}
     * @return Promise
     */
    send(event: string, message: any, receiver: LooseObject = {}): Promise<any> {
        event = JSON.stringify({
            event: event,
            message: message,
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
                this.log('Your message will be sent when server connection is recovered!');
                this.event.once('open', () => {
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

    private log(message: any): void {
        console.log(message);
    };

    private changeState(stateName: string, event: any[]): void {
        this.connectionState = stateName;

        if ('close' === stateName && this.willReconnect) {
            this.reconnect();
        }

        this.event.dispatch(stateName, [event]);
    };

    private closeConnection(reconnect: boolean = false): void {
        if (reconnect) {
            this.willReconnect = true;
            this.connectionState = 'internal_reconnection';
        }

        this.websocket.close();
    };

    private createSocket(isReconnecting: boolean = false): void {
        if (true === isReconnecting) {
            this.connectionState = 'reconnecting';
            this.event.dispatch('reconnecting');
        } else {
            this.connectionState = 'connecting';
            this.event.dispatch('connecting');

        }

        if (this.wsUri.indexOf('ws://') === -1 && this.wsUri.indexOf('wss://') === -1) {
            this.wsUri = 'ws://' + window.location.host + this.wsUri;
        }

        this.websocket = new WebSocket(this.wsUri, []);

        this.websocket.addEventListener('open', (...args) => {
            if (this.defaultAuthToken) {
                this.send('auth.token', this.defaultAuthToken)
            }

            if ('reconnecting' === this.connectionState) {
                this.event.dispatch('reconnect');
            }

            this.changeState('open', args);
        });

        this.websocket.addEventListener('message', (...args) => {
            this.event.dispatch('message', args);
        });

        this.websocket.addEventListener('close', (...args) => {
            this.changeState('close', args);
        });

        this.websocket.addEventListener('error', (...args) => {
            this.changeState('error', args);
        });
    }
}
