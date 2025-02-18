import {
  configureStore,
  createAction,
  createSlice,
  isAnyOf,
} from '@reduxjs/toolkit'

import type { AnyAction, PayloadAction, Action } from '@reduxjs/toolkit'

import {
  createActionListenerMiddleware,
  createListenerEntry,
  addListenerAction,
  removeListenerAction,
} from '../index'

import type {
  When,
  ActionListenerMiddlewareAPI,
  TypedAddListenerAction,
  TypedAddListener,
  Unsubscribe,
} from '../index'
import { JobCancellationException } from '../job'
import { Outcome } from '../outcome'

interface CounterState {
  value: number
}

const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 } as CounterState,
  reducers: {
    increment(state) {
      state.value += 1
    },
    decrement(state) {
      state.value -= 1
    },
    // Use the PayloadAction type to declare the contents of `action.payload`
    incrementByAmount: (state, action: PayloadAction<number>) => {
      state.value += action.payload
    },
  },
})
const { increment, decrement, incrementByAmount } = counterSlice.actions

describe('Saga-style Effects Scenarios', () => {
  let middleware: ReturnType<typeof createActionListenerMiddleware>

  let store = configureStore({
    reducer: counterSlice.reducer,
    middleware: (gDM) => gDM().prepend(createActionListenerMiddleware()),
  })

  const testAction1 = createAction<string>('testAction1')
  type TestAction1 = ReturnType<typeof testAction1>
  const testAction2 = createAction<string>('testAction2')
  type TestAction2 = ReturnType<typeof testAction2>
  const testAction3 = createAction<string>('testAction3')
  type TestAction3 = ReturnType<typeof testAction3>

  type RootState = ReturnType<typeof store.getState>

  let addListener: TypedAddListener<RootState>

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  beforeEach(() => {
    middleware = createActionListenerMiddleware()
    addListener = middleware.addListener as TypedAddListener<RootState>
    store = configureStore({
      reducer: counterSlice.reducer,
      middleware: (gDM) => gDM().prepend(middleware),
    })
  })

  test('Long polling loop', async () => {
    // Reimplementation of a saga-based long-polling loop that is controlled
    // by "start/stop" actions. The infinite loop waits for a message from the
    // server, processes it somehow, and waits for the next message.
    // Ref: https://gist.github.com/markerikson/5203e71a69fa9dff203c9e27c3d84154
    const eventPollingStarted = createAction('serverPolling/started')
    const eventPollingStopped = createAction('serverPolling/stopped')

    // For this example, we're going to fake up a "server event poll" async
    // function by wrapping an event emitter so that every call returns a
    // promise that is resolved the next time an event is emitted.
    // This is the tiniest event emitter I could find to copy-paste in here.
    let createNanoEvents = () => ({
      events: {} as Record<string, any>,
      emit(event: string, ...args: any[]) {
        ;(this.events[event] || []).forEach((i: any) => i(...args))
      },
      on(event: string, cb: (...args: any[]) => void) {
        ;(this.events[event] = this.events[event] || []).push(cb)
        return () =>
          (this.events[event] = (this.events[event] || []).filter(
            (l: any) => l !== cb
          ))
      },
    })
    const emitter = createNanoEvents()

    // Rig up a dummy "receive a message from the server" API we can trigger manually
    function pollForEvent() {
      return new Promise<{ type: string }>((resolve, reject) => {
        const unsubscribe = emitter.on('serverEvent', (arg1: string) => {
          unsubscribe()
          resolve({ type: arg1 })
        })
      })
    }

    // Track how many times each message was processed by the loop
    const receivedMessages = {
      a: 0,
      b: 0,
      c: 0,
    }

    let pollingJobStarted = false
    let pollingJobCanceled = false

    addListener({
      actionCreator: eventPollingStarted,
      listener: async (action, listenerApi) => {
        listenerApi.unsubscribe()

        // Start a child job that will infinitely loop receiving messages
        const pollingJob = listenerApi.job.launch(async (handle) => {
          pollingJobStarted = true
          try {
            while (true) {
              const eventPromise = pollForEvent()
              // Cancelation-aware pause for a new server message
              const serverEvent = await handle.pause(eventPromise)

              // Process the message. In this case, just count the times we've seen this message.
              if (serverEvent.type in receivedMessages) {
                receivedMessages[
                  serverEvent.type as keyof typeof receivedMessages
                ]++
              }
            }
          } catch (err) {
            if (err instanceof JobCancellationException) {
              pollingJobCanceled = true
            }
          }
          return Outcome.ok(0)
        })
        pollingJob.run()

        // Wait for the "stop polling" action
        await listenerApi.condition(eventPollingStopped.match)
        pollingJob.cancel()
      },
    })

    store.dispatch(eventPollingStarted())
    await delay(5)
    expect(pollingJobStarted).toBe(true)

    await delay(5)
    emitter.emit('serverEvent', 'a')
    // Promise resolution
    await delay(1)
    emitter.emit('serverEvent', 'b')
    // Promise resolution
    await delay(1)

    store.dispatch(eventPollingStopped())

    // Have to break out of the event loop to let the cancelation promise
    // kick in - emitting before this would still resolve pollForEvent()
    await delay(1)
    emitter.emit('serverEvent', 'c')

    // A and B were processed earlier. The first C was processed because the
    // emitter synchronously resolved the `pollForEvents` promise before
    // the cancelation took effect, but after another pause, the
    // cancelation kicked in and the second C is ignored.
    expect(receivedMessages).toEqual({ a: 1, b: 1, c: 0 })
    expect(pollingJobCanceled).toBe(true)
  })
})
