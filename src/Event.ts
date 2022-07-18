export default class Event {
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

        this.listeners['on'][name].push(listener);
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