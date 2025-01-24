import { trpc } from "@/utils/trpc";
import React, { useState } from "react";
import { Button, TextInput, View, Text, StyleSheet } from "react-native";

const App = () => {
  const [inputValue, setInputValue] = useState("");
  const [queryInput, setQueryInput] = useState<string | null>(null);

  const { data, isLoading, error } = trpc.hello.useQuery(queryInput);

  const handleButtonClick = () => {
    setQueryInput(inputValue || null); // Update queryInput to trigger the query
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Enter a name"
        value={inputValue}
        onChangeText={setInputValue}
      />
      <Button title="Send Request" onPress={handleButtonClick} />
      {isLoading && <Text>Loading...</Text>}
      {error && <Text style={styles.error}>Error: {error.message}</Text>}
      {data && <Text style={styles.response}>Response: {data}</Text>}
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
