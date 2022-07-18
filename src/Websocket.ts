import Event from "./Event";

export default class Websocket {
    private websocket: WebSocket;
    private reconnectionInterval: number = 1000;
    private connectionState: string = 'standby';
    private willReconnect: boolean = true;
    private event: Event;

    private defaultAuthToken: string | null = null;
    private reconnectionTimeout: NodeJS.Timeout = null;

    constructor(
        private wsUri: string,
        private options: any[] = []
    ) {
        // HANDLE MESSAGE/COMMAND DISPATCH WHEN DOM FINISHED LOADING
        this.onReady(() => {
            // Inspect messages and dispatch command
            this.onMessage((payload) => {
                if (payload.command) {
                    // Dispatch unfiltered command events
                    this.event.dispatch('command', [payload]);

                    // Dispatch filtered command event
                    this.event.dispatch('command.' + payload.command, [payload]);
                }
            });
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
    onOpen(listener): Websocket {
        this.event.on('open', listener);
        return this;
    };

    /**
     * This event fires when message is received
     * @param listener
     */
    onMessage(listener): Websocket {
        this.event.on('message', (payload: any) => {
            if ('string' === typeof payload.data) {
                listener(JSON.parse(payload.data), payload)
            } else {
                listener(payload, payload);
            }
        });

        return this;
    };

    /**
     * Listens to filtered websocket command message
     *
     * @param command {string}
     * @param listener {callback}
     */
    onCommand(command: string, listener: CallableFunction): Websocket {
        this.event.on('command.' + command, listener);
        return this;
    };

    /**
     * Listens to RTC socket command
     *
     * @param listener
     */
    onAnyCommand(listener: CallableFunction): Websocket {
        this.event.on('command', listener);
        return this;
    };

    /**
     * This event fires when this connection is closed
     *
     * @param listener
     */
    onClose(listener: CallableFunction): Websocket {
        this.event.on('close', listener);
        return this;
    };

    /**
     * This event fires when client is disconnecting this connection
     *
     * @param listener
     */
    onDisconnect(listener: CallableFunction): Websocket {
        this.event.on('custom.disconnect', listener);
        return this;
    };

    /**
     * This event fires when an error occurred
     * @param listener
     */
    onError(listener: CallableFunction): Websocket {
        this.event.on('error', listener);
        return this;
    };

    /**
     * This event fires when this connection is in connecting state
     * @param listener
     */
    onConnecting(listener: CallableFunction): Websocket {
        this.event.on('connecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection is in connecting state
     * @param listener
     */
    onReconnecting(listener: CallableFunction): Websocket {
        this.event.on('reconnecting', listener);
        return this;
    };

    /**
     * This event fires when this reconnection has been reconnected
     * @param listener
     */
    onReconnect(listener: CallableFunction): Websocket {
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
    setReconnectionInterval(interval: number): Websocket {
        this.reconnectionInterval = interval;
        return this;
    };

    /**
     * Set an authentication token that will be included in each outgoing message
     *
     * @param token {string} authentication token
     */
    setAuthToken(token: string): Websocket {
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
     * @returns {Websocket}
     */
    connect(): Websocket {
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
     * @param command {any} command name
     * @param message {array|object|int|float|string} message
     * @return Promise
     */
    send(command: string, message: {} = {}): Promise<any> {
        command = JSON.stringify({
            command: command,
            message: message,
            time: new Date().getTime(),
            token: this.defaultAuthToken
        });

        //Send message
        return new Promise((resolve, reject) => {
            //Only send message when client is connected
            if (this.isOpened()) {
                try {
                    this.websocket.send(command);
                    resolve(this);
                } catch (error) {
                    reject(error);
                }

                //Send message when connection is recovered
            } else {
                this.log('Your message will be sent when server connection is recovered!');
                this.event.once('open', () => {
                    try {
                        this.websocket.send(command);
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

        this.websocket = new WebSocket(this.wsUri, this.options);

        this.websocket.addEventListener('open', (...args) => {
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
