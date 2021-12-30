import { Mutex } from 'async-mutex';

/**
 * Queue with mutex lock to ensure that it is never being modified concurrently (it is accessed by several async/event handler functions)
 */
export default class Queue {

	constructor() {
        this.queueAccessMutex = new Mutex();
		this.internal = [];
	}

    setInternalArray(array) {
        this.internal = array;
    }


	getShallowClone() {
		const a = [];
		this.internal.forEach((item) => a.push(item));
		return a;
	}

	get(index) {
		return this.internal[index];
	
	}

    enqueue(...items) {
		return this.internal.push(...items);
	}

    enqueueFirst(item) {
        this.enqueue(item);
		this.swap(0, this.internal.length - 1);
	}
    
	swap(index1, index2) {
		let temporaryValue = this.internal[index1];
		this.internal[index1] = this.internal[index2];
		this.internal[index2] = temporaryValue;
	}

    async acquireLock(interaction) {
        const unlockQueue = await this.queueAccessMutex.acquire()
        if (interaction) {
            interaction.unlockQueueReply = (msg) => {
                unlockQueue();
                interaction.reply(msg);
            }
        }
        return unlockQueue;
    }

    length() {
        return this.internal.length;
    }

    shuffle() {
		let currentIndex = this.internal.length, randomIndex;

		while (currentIndex > 0) {
			randomIndex = Math.floor(Math.random() * currentIndex);
			currentIndex -= 1;

			this.swap(currentIndex, randomIndex);
		}
	}

    slice(start, end) {
		return this.internal.slice(start, end);
	}

    splice(start, deleteCount, ...items) {
		return this.internal.splice(start, deleteCount, ...items);
	}

    jump(index) {
        this.internal = this.slice(index)
    }

	dequeue() {
        return this.internal.shift();
	}

	remove(index) {
        return this.internal.splice(index, 1);
	}
    
	clear() {
        this.internal = [];
	}
}