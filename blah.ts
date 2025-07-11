const requestId = new AsyncContext.Variable();

async function doSomething() {
  console.log(requestId.getStore());
}

export async function main() {
  requestId.run(crypto.randomUUID(), async () => {
    doSomething();
  });
  requestId.run(crypto.randomUUID(), async () => {
    doSomething();
  });
}

await main();
