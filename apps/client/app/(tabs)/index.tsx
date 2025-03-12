import { api } from "@/utils/trpc";
import React, { useState } from "react";
import { Button, TextInput, View, Text, StyleSheet } from "react-native";

const App = () => {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");

  const { data, isLoading, error } = api.userRouter.all.useQuery();

  const { mutate, error: mutateError } = api.userRouter.create.useMutation({
    async onSuccess() {
      setFirstName("");
      setLastName("");
      setEmail("");
      await api.useUtils().userRouter.all.invalidate();
    },
  });

  const handleButtonClick = () =>
    mutate({
      firstName,
      lastName,
      email,
    });

  console.log(error?.message);
  return (
    <View style={styles.container}>
      <Text>Hei dette er en tekst</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter a FirstName"
        value={firstName}
        onChangeText={setFirstName}
      />
      <TextInput
        style={styles.input}
        placeholder="Enter a LastName"
        value={lastName}
        onChangeText={setLastName}
      />
      <TextInput
        style={styles.input}
        placeholder="Enter a email"
        value={email}
        onChangeText={setEmail}
      />
      <Button title="Send Request" onPress={handleButtonClick} />
      {isLoading && <Text>Loading...</Text>}
      {error && <Text style={styles.error}>QueryError: {error.message}</Text>}
      {mutateError && (
        <Text style={styles.error}>MutateError: {mutateError.message}</Text>
      )}
      {data && (
        <Text style={styles.response}>ResponseLenght: {data.length}</Text>
      )}
      {data && <Text style={styles.response}>Response: {data.join(" ")}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  input: {
    height: 40,
    borderColor: "#ccc",
    borderWidth: 1,
    paddingHorizontal: 10,
    width: "100%",
    marginBottom: 20,
  },
  response: {
    marginTop: 20,
    color: "green",
  },
  error: {
    marginTop: 20,
    color: "red",
  },
});

export default App;
