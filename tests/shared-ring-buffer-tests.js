function runRingBufferTests(SharedRingBuffer, description) {
  describe(description, () => {
    it('should be defined', () => {
      expect(SharedRingBuffer).toBeDefined();
    });

    describe('Initialization', () => {
      it('initializes correctly with valid parameters', () => {
        const rb = new SharedRingBuffer(128, 4);
        expect(rb.capacity).toBe(128 * 4);
        expect(rb.available()).toBe(0);
        expect(rb.space()).toBe(rb.capacity - 1);
        expect(rb.overflows()).toBe(0);
      });

      it('can reuse an existing SharedArrayBuffer', () => {
        const rb1 = new SharedRingBuffer(128, 4);
        const sab = rb1.getBuffer();

        const rb2 = new SharedRingBuffer(128, 4, sab);
        expect(rb2.capacity).toBe(rb1.capacity);
        expect(rb2.getBuffer()).toBe(sab);
      });
    });

    describe('Operations', () => {
      let rb;

      beforeEach(() => {
        rb = new SharedRingBuffer(4, 4); // capacity 16
      });

      it('pushes and pulls basic data correctly', () => {
        const data = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        const pushed = rb.push(data);
        expect(pushed).toBe(true);
        expect(rb.available()).toBe(4);

        const out = rb.pull(4);
        expect(out).toBeDefined();
        expect(out.length).toBe(4);
        expect(Array.from(out)).toEqual([1.0, 2.0, 3.0, 4.0]);
        expect(rb.available()).toBe(0);
      });

      it('handles overflow properly by rejecting push', () => {
        const space = rb.space();
        const data = new Float32Array(space);
        expect(rb.push(data)).toBe(true);
        expect(rb.available()).toBe(space);

        const overflowData = new Float32Array([1.0]);
        expect(rb.push(overflowData)).toBe(false); // only capacity-1 space available initially
        expect(rb.overflows()).toBe(1);
      });

      it('handles underflow properly by returning null on pull', () => {
        const out = rb.pull(10);
        expect(out).toBeNull();
      });

      it('handles peek without consuming', () => {
        const data = new Float32Array([5.0, 6.0]);
        rb.push(data);

        const peekOut = rb.peek(2);
        expect(peekOut).toBeDefined();
        expect(Array.from(peekOut)).toEqual([5.0, 6.0]);
        expect(rb.available()).toBe(2); // Still available

        const pullOut = rb.pull(2);
        expect(pullOut).toBeDefined();
        expect(Array.from(pullOut)).toEqual([5.0, 6.0]);
        expect(rb.available()).toBe(0); // Now consumed
      });

      it('handles wrap-around correctly', () => {
        // fill up
        rb.push(new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0])); // 12 elements
        expect(rb.available()).toBe(12);

        // consume some to move read pointer
        const out1 = rb.pull(8);
        expect(Array.from(out1)).toEqual([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        expect(rb.available()).toBe(4);

        // push more to trigger wrap-around
        const out2 = rb.push(new Float32Array([13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]));
        expect(out2).toBe(true);
        expect(rb.available()).toBe(11); // 4 left + 7 new

        // pull to verify wrap-around read
        const out3 = rb.pull(11);
        expect(Array.from(out3)).toEqual([9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]);
      });

      it('handles exact wrap-around condition on push and pull', () => {
         rb.push(new Float32Array(15).fill(1)); // max out buffer space
         rb.pull(15); // empty it

         const nextWrite = new Float32Array([2.0, 3.0, 4.0]); // should wrap
         expect(rb.push(nextWrite)).toBe(true);

         const nextRead = rb.pull(3);
         expect(Array.from(nextRead)).toEqual([2.0, 3.0, 4.0]);
      });

      it('handles reset', () => {
        rb.push(new Float32Array([1.0, 2.0]));
        expect(rb.available()).toBe(2);
        rb.reset();
        expect(rb.available()).toBe(0);
        expect(rb.space()).toBe(rb.capacity - 1);
      });

      it('isSupported returns a boolean', () => {
        expect(typeof SharedRingBuffer.isSupported()).toBe('boolean');
      });
    });
  });
}

module.exports = runRingBufferTests;
